// train.js — `train-v16`. The tile, learned from its own frames, by brush.
//
// `assemble` built the surfaces and `frame` path-traced them from a fixed
// camera set. The seed is those surfaces sampled at the tile's whole budget
// (client/lib/sampling.js), so nothing has to be discovered: brush
// (client/lib/brush.js) is handed the frames, their poses and the seed as a
// nerfstudio dataset in the tab's own file system, and moves colour, opacity,
// size and position until the tile reproduces the frames. Ordinary 3D
// gaussian splatting, done by the people who do nothing else.
//
// v3 seeded half the budget and wrote back exactly what brush produced: over a
// few hundred steps a splat never grew past the seed's own extent, and the
// tile came out with holes everywhere between them. v4 tried to lift brush's
// `split-at-screen-size` so they could grow during the run, and brush's
// rasteriser panicked — that cap is what bounds how many splats a screen tile
// may hold. v5 leaves the trainer's caps where they are and widens every splat
// after the run instead (`widen`, SCALE): the extent the trainer settled on,
// times a number, in the two directions a splat is wide — which is the one
// thing that actually closes the gaps, and cannot be undone by anything
// downstream. Fewer splats (db/0111 halved the budget), each of them bigger.
//
// v14 seeds the ground before anything that stands on it (ground_floor): the
// seed used to be allocated across every triangle at once, and the ground —
// smooth, one colour, and the surface a player is always looking at — lost
// every time to the roofs and the trees standing on it.
//
// v15 reads one dataset (client/atoms/dataset.js): the frames, the poses and
// the assembled tile in one tar, where v14 read an assemble tar and three to
// six frame tars.
//
// v16 starts where brush's own app starts: a seed of three tenths of the
// budget (what assemble samples, sampling.js SEED), and brush's own refine interval
// and growth window (client/lib/brush.js configFor). Handed one of these
// datasets, that app had the tile readable in a minute; this, from a tenth
// of the budget, refining every thirty steps and growing for 1 440 of them,
// had blobs.
//
// v17 lays a third of that seed on a lattice across the ground (sampling.js
// gridSurfaces, `seed_grid`): three tenths allocated by area still came back
// with stretches of hillside tens of metres across that no splat had landed
// on, and a trainer cannot move what is not there. The recipe is sampling.js
// seedOf, which is also what assemble writes as init.ply and what
// tools/dataset.mjs puts in the folder for brush's app: one seed, wherever
// the run happens. And the frames' alpha is read as that app reads it
// (configFor): transparent, not masked.
//
// Four poses are held back (client/lib/frames.js): brush never sees them, and
// `verify` renders two of them in another tab. Invariant 8: probabilistic
// quality assurance, not proof.

import { cameraSet, viewCount } from '../lib/cameras.js';
import { boundsOf as frameBounds, groundOf } from './frame.js';
import { pointsPicture, shuffled } from '../lib/preview.js';
import { dataset } from '../lib/dataset.js';
export { dataset };
import { holdout } from '../lib/frames.js';
import {
    brushApp, configFor, deviceStats, keep, loadBrush, readSplats, trainIn,
} from '../lib/brush.js';
import { unpackMeshes } from '../lib/mesh.js';
import { datasetDir, removeDir } from '../lib/opfs.js';
import { bboxOf, writePly } from '../lib/ply.js';
import { rngOf, seedOf } from '../lib/sampling.js';
import { readTar, writeTar } from '../lib/tar.js';

// v18 hands brush the atom's `brush` knobs (client/lib/brush.js configFor):
// db/0189 lets splats grow in the run rather than be widened after it.
export const ALGO = 'train-v18';
// How far past the seed's box a splat may end up and still be this tile's,
// measured up and down. Across the ground there is far less room than this:
// see EDGE_PAD_M.
export const MARGIN = 0.15;
// And across the ground, in metres. `assemble` clips its meshes to the tile
// plus CLIP_M = 8 m (client/atoms/assemble.js), and `bbox_fits` accepts a
// tile's splats out to the tile plus 10 m (db/0015_structural.sql) — so a
// trained tile has two metres of ground to spare, at every zoom, and this
// leaves one of them for the arithmetic.
//
// MARGIN used to do this job on all three axes: 15 % of a z14 tile is a 254 m
// halo, and `keep` handed back every splat brush had moved into it. One of
// them past 856.6 m made `result.bbox` wider than the rule allows, submit_atom
// refused the finished run, put the atom back to `ready` with an attempt
// counted (db/0094_apieceisnotleftinaclosedjob.sql), and the tab claimed it
// and trained it again — a quarter of an hour a time, three times, saying
// nothing about why.
export const EDGE_PAD_M = 1;
// And never less than this, in metres. A share of the extent is nothing at all
// on an axis the seed has no extent on, and a tile whose ground came back as
// nodata (server/splatworld/dem.py) has a seed box exactly zero metres high:
// `keep` then asks every trained splat to sit at exactly that height, none
// does, and a finished run is thrown away whole — "brush returned 35903 splats
// and none inside the tile". The server no longer serves such a tile, and a
// run is no longer destroyed by one if it does.
export const MIN_PAD_M = 2;
// How much wider every trained splat is made before it is written: the ground
// is covered by splats overlapping their neighbours, and the trainer settles
// on extents that leave the background showing between them. A multiple, so it
// is relative to whatever size a splat ended up at; the atom's `scale` param
// is what turns it, without touching this file. It was 3 while a tile came out
// with a splat per 77 m² in it: at that spacing widening is not overlap, it is
// twenty-six-metre blobs smeared over a hillside, and it was hiding a tile that
// had not been filled rather than covering one that had.
export const SCALE = 1;
// A picture of the run every so many iterations, from its first held-out
// pose, over the first PREVIEW_SPLATS of the (shuffled) list.
export const PREVIEW_EVERY = 200;
export const PREVIEW_SPLATS = 150000;

const decoder = new TextDecoder();

// The window a trained splat has to be inside to be this tile's. Height is
// the seed's own span plus a share of it; x and z are the seed's span plus a
// metre, because that is all the room the server's rule leaves (EDGE_PAD_M).
export function bounds(seed, margin) {
    const box = bboxOf(seed);
    const pad = [0, 1, 2].map((k) => (k === 1
        ? Math.max((box[k + 3] - box[k]) * margin, MIN_PAD_M)
        : Math.min((box[k + 3] - box[k]) * margin, EDGE_PAD_M)));
    return { lo: box.map((v, k) => v - pad[k % 3]).slice(0, 3),
        hi: box.slice(3).map((v, k) => v + pad[k]) };
}

function pack(splats, files) {
    return writeTar([
        { name: 'splats.ply', bytes: writePly(splats) },
        { name: 'height.r16', bytes: files.get('height.r16') },
        { name: 'colliders.json', bytes: files.get('colliders.json') },
        { name: 'scene.json', bytes: files.get('scene.json') },
    ]);
}


// One brush run, start to finish: the dataset written, the device shared,
// the run pumped with a picture every PREVIEW_EVERY iterations, the splats
// read back, and everything torn down whatever happened.
// What brush may not be handed: a splat with no finite size or position. Its
// log-scale is minus infinity, the optimiser spreads that through the run, and
// what comes back is a panic from brush's own rasteriser a hundred steps later
// ("num_intersections > max possible"), which says nothing about where it came
// from. This does.
function checkSeed(seed) {
    let bad = 0;
    for (let i = 0; i < seed.count; i++) {
        if (!(seed.sx[i] > 0 && seed.sy[i] > 0 && seed.sz[i] > 0)
            || !Number.isFinite(seed.x[i] + seed.y[i] + seed.z[i])) bad++;
    }
    if (bad) {
        throw new Error(`the seed has ${bad} splat(s) of ${seed.count} with no finite `
            + 'size or place; brush cannot be handed those');
    }
}

async function trainWithBrush({ atom, seed, tars, scene, eye, iters, budget, size, log,
    knobs }) {
    const brush = await loadBrush();
    // Which card this tab has, for the log only: brush picks its own
    // (client/lib/brush.js brushApp), the way its own app does.
    const adapter = await globalThis.navigator?.gpu?.requestAdapter?.().catch(() => null);
    if (!adapter) throw new Error('no WebGPU adapter: training needs one');
    const name = `train-${atom.id}`;
    checkSeed(seed);
    const ds = dataset(tars, atom.params?.camera_set, seed);
    const dir = await datasetDir(name, ds.files);
    // Which card this actually got, and how much of one. A run that is slow
    // because the browser handed the tab another adapter, or because the
    // frames and the splats do not fit in the card and it is paging, looks
    // exactly like a run that is slow — and a step time says neither.
    const info = adapter.info ?? await adapter.requestAdapterInfo?.() ?? {};
    log?.({ event: 'training', tile: scene.tile, on: 'brush', views: ds.views,
        held: ds.held, from: seed.count, iters, size, budget,
        gpu: [info.vendor, info.architecture, info.device, info.description]
            .filter(Boolean).join(' ') || 'unnamed adapter',
        vram_mb: Math.round((adapter.limits?.maxBufferSize ?? 0) / 1048576),
        frames_mb: Math.round(ds.views * size * size * 4 / 1048576) });
    let training = null;
    let held = null;
    let last = { iter: 0, ms: 0, brush: 0, ours: 0 };
    try {
        const { app, device } = await brushApp(brush);
        held = device;
        training = await trainIn(app, dir, (init) => configFor(init, { iters, budget, size,
            seed: atom.seed ?? 42, refineEvery: Number(atom.params?.refine_every) || 0,
            tuning: atom.params?.brush }), {
            // How many steps brush is asked for a call. One, unless the page
            // was opened with ?train_batch=N: the knob that measures whether
            // the pump between steps is what a step costs.
            steps: Math.max(1, Number(knobs?.train_batch) || 1),
            // Every tenth step, with the pace since the last report: a silent
            // minute on a slow card reads as a hang, and elapsed-over-steps
            // would carry the loading and tuning time in front of step one.
            onStep: (iter, ms, spent) => {
                if (iter % 10 !== 0 && iter !== 1) return;
                const n = Math.max(iter - last.iter, 1);
                const per = last.iter ? Math.round((ms - last.ms) / n) : null;
                // And where those steps went, per step: inside brush, or in
                // this code between its calls; and what they asked of the
                // device — the readbacks and their wait are where a slow
                // step on an idle GPU goes (client/lib/brush.js deviceStats).
                const asked = deviceStats(n);
                const split = { in_brush: Math.round((spent.brush - last.brush) / n),
                    ours: Math.round((spent.ours - last.ours) / n) };
                last = { iter, ms, brush: spent.brush, ours: spent.ours };
                log?.({ event: 'train', iter, of: iters, ms: Math.round(ms), per,
                    ...split, ...asked });
            },
            onWarn: (text) => log?.({ event: 'warning', text }),
            onStage: (text) => log?.({ event: 'stage', text }),
            onBatch: (iter, t) => preview(t, iter, iters, eye, log),
        });
        // Async on some brush revisions, a plain value on others.
        const current = await training.currentSplats();
        if (!current) throw new Error('brush produced no splats');
        const splats = await readSplats(current);
        current.free?.();
        return splats;
    } finally {
        training?.free?.();
        await removeDir(name).catch(() => {});
        held?.destroy?.();
    }
}

async function preview(training, iter, iters, eye, log) {
    if (iter % PREVIEW_EVERY !== 0 || !iter) return;
    const cur = await training.currentSplats();
    if (!cur) return;
    const some = await readSplats(cur, PREVIEW_SPLATS);
    const total = cur.numSplats;
    cur.free?.();
    log?.({ event: 'train', iter, of: iters, splats: total, picture: pointsPicture(some, eye) });
}

// Every splat, wider by `k` in the two directions it is wide. The smallest of
// its three extents is the one across the surface it lies on — a splat is a
// disc, and thickening it would put fog over the ground rather than cover it —
// so that one is left alone, whichever axis the trainer's rotation put it on.
export function widen(f, k) {
    if (!(k > 0) || k === 1) return f;
    for (let i = 0; i < f.count; i++) {
        const thin = Math.min(f.sx[i], f.sy[i], f.sz[i]);
        if (f.sx[i] !== thin) f.sx[i] *= k;
        if (f.sy[i] !== thin) f.sy[i] *= k;
        if (f.sz[i] !== thin) f.sz[i] *= k;
    }
    return f;
}

export async function run({ atom, inputs, log, knobs }) {
    const built = inputs?.dataset ?? inputs?.assemble;
    if (!built) throw new Error('train needs the dataset artifact');
    const tars = inputs.dataset ? [inputs.dataset]
        : [].concat(inputs.frames ?? []).filter(Boolean);
    if (!tars.length) throw new Error('train needs at least one frame artifact');
    const files = readTar(built);
    const scene = JSON.parse(decoder.decode(files.get('scene.json')));
    const meshes = unpackMeshes(files.get('mesh.bin'), scene.meshes);
    const budget = Number(atom.params?.budget) || scene.budget;
    const iters = Number(atom.params?.iters) || 4000;
    const size = Number(atom.params?.size) || 1280;
    const { z, x, y } = scene.tile;
    const random = rngOf(atom, z, x, y);
    // Shuffled so any prefix is a fair sample: the preview reads a prefix.
    const placed = seedOf(meshes, budget, random, atom.params ?? {});
    const seed = shuffled(placed.seed, random);
    const set = atom.params?.camera_set;
    const ground = groundOf(files, scene);
    const eye = cameraSet(set, frameBounds(meshes), ground)[holdout(viewCount(set) || 1)[0]];
    log?.({ event: 'seeded', tile: scene.tile, splats: seed.count, share: placed.share,
        grid: placed.grid, ground_floor: placed.floor, picture: pointsPicture(seed, eye) });

    const splats = await trainWithBrush({ atom, seed, tars, scene, eye, iters, budget, size, log,
        knobs });
    const box = bounds(seed, MARGIN);
    const scale = Number(atom.params?.scale) || SCALE;
    const out = widen(keep(splats, box.lo, box.hi), scale);
    if (!out.count) {
        const span = (f) => bboxOf(f).map((v) => v.toFixed(1)).join(' ');
        const win = [...box.lo, ...box.hi].map((v) => v.toFixed(1)).join(' ');
        throw new Error(`brush returned ${splats.count} splats and none inside the tile: `
            + `theirs span [${span(splats)}], the seed [${span(seed)}], `
            + `the window kept [${win}]`);
    }
    if (out.count > budget) throw new Error(`${out.count} splats is over the budget of ${budget}`);
    const tar = pack(out, files);
    log?.({ event: 'trained', tile: scene.tile, splats: out.count, of: splats.count, scale });
    return {
        files: [{ ext: 'tar', kind: 'ply', algo_version: ALGO, bytes: tar }],
        output: 'tar',
        result: {
            bytes: tar.length, splat_count: out.count, finite: true,
            bbox: bboxOf(out), origin: scene.origin, tile: scene.tile,
            iters, backend: 'brush', frame_size: size, seeded: seed.count, scale,
            seed_share: placed.share, seed_grid: placed.grid, ground_floor: placed.floor,
            dropped: splats.count - out.count,
        },
    };
}
