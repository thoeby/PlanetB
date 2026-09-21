// train.js — `train-v14`. The tile, learned from its own frames, by brush.
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
// v14 seeds the ground before anything that stands on it (GROUND_FLOOR): the
// seed used to be allocated across every triangle at once, and the ground —
// smooth, one colour, and the surface a player is always looking at — lost
// every time to the roofs and the trees standing on it.
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
    brushDevice, configFor, deviceStats, keep, loadBrush, readSplats, trainIn,
} from '../lib/brush.js';
import { unpackMeshes } from '../lib/mesh.js';
import { datasetDir, removeDir } from '../lib/opfs.js';
import { bboxOf, writePly } from '../lib/ply.js';
import { rngOf, seedSurfaces } from '../lib/sampling.js';
import { readTar, writeTar } from '../lib/tar.js';

export const ALGO = 'train-v14';
// The in-plane sigma of a seed splat as a share of its spacing. Sigma, not
// radius: a gaussian is visible out to about two of them, so a splat at 1.15
// covered four to five times the distance to its neighbour — twenty times the
// area it is meant to hold — and `widen` multiplied that again. A tile of
// 134 000 splats at 4.6 m spacing came back looking like a few dozen blobs,
// because each one was twenty metres across. Half the spacing puts the
// two-sigma edge at one spacing: covered, with overlap, and no smear.
export const SPREAD = 0.5;
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
// The seed is this share of the budget unless the atom says otherwise; brush
// grows the rest where the frames say the picture is wrong (client/lib/brush.js
// configFor). What decides whether a seed ever reaches the budget is how many
// refine passes the growth window holds, not how big the seed is, because
// brush grows by a fraction of what it already has — about a tenth, measured
// on the run that started this (22 500 → 37 000 in five passes). At brush's
// own interval those five passes are all a 1 200-step run gets, which is why
// a fortieth of the budget came back as a splat per 77 m²; the answer is not
// a bigger seed alone but a shorter `refine_every` as well (db/0138). That
// bought passes and lost yield: at twenty steps a pass there is a fifth as
// much gradient built up, so fewer splats clear the threshold, and 36 passes
// came to 5.96× rather than 33× — 134 000 of a 600 000 budget. So the seed
// carries the tile and growth puts the rest where the frames say the picture
// is wrong (db/0145).
export const SEED_SHARE = 0.1;
// And at least this much of the seed goes on the ground, however little there
// is to see on it. The allocation weights a triangle by its colour and normal
// spread (client/lib/sampling.js detailOf), and a hillside is one colour over
// hundreds of square metres: it is the surface that loses every time, and the
// one a player is always looking at. A hole in a wall is a missing wall; a
// hole in the ground is the sky underneath it. Measured on a tile of ground
// with four times its own area of roof and wall standing on it, the ground was
// given a sixth of the seed and its splats came out 1.8 m apart.
//
// Two thirds of a tenth of the budget: on a z14 that is 53 000 splats over
// 1693 m, 7.3 m apart, and a splat two sigma wide at that spacing covers.
export const GROUND_FLOOR = 0.66;
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

async function trainWithBrush({ atom, seed, tars, scene, eye, iters, budget, size, log }) {
    const brush = await loadBrush();
    const { adapter, device } = await brushDevice();
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
        vram_mb: Math.round((device.limits.maxBufferSize ?? 0) / 1048576),
        frames_mb: Math.round(ds.views * size * size * 4 / 1048576) });
    let training = null;
    let last = { iter: 0, ms: 0 };
    try {
        const app = new brush.BrushApp();
        app.initExisting(adapter, device, device.queue);
        training = await trainIn(app, dir, (init) => configFor(init, { iters, budget, size,
            seed: atom.seed ?? 42, refineEvery: Number(atom.params?.refine_every) || 0 }), {
            // Every tenth step, with the pace since the last report: a silent
            // minute on a slow card reads as a hang, and elapsed-over-steps
            // would carry the loading and tuning time in front of step one.
            onStep: (iter, ms) => {
                if (iter % 10 !== 0 && iter !== 1) return;
                const per = last.iter ? Math.round((ms - last.ms) / (iter - last.iter)) : null;
                // And what those steps asked of the device, per step: the
                // readbacks and their wait are where a slow step on an idle
                // GPU goes (client/lib/brush.js deviceStats).
                const asked = deviceStats(Math.max(iter - last.iter, 1));
                last = { iter, ms };
                log?.({ event: 'train', iter, of: iters, ms: Math.round(ms), per, ...asked });
            },
            onWarn: (text) => log?.({ event: 'warning', text }),
            onStage: (text) => log?.({ event: 'stage', text }),
            onBatch: (iter, t) => preview(device, t, iter, iters, eye, log),
        });
        const current = training.currentSplats();
        if (!current) throw new Error('brush produced no splats');
        const splats = await readSplats(device, current);
        current.free?.();
        return splats;
    } finally {
        training?.free?.();
        await removeDir(name).catch(() => {});
        device.destroy?.();
    }
}

async function preview(device, training, iter, iters, eye, log) {
    if (iter % PREVIEW_EVERY !== 0 || !iter) return;
    const cur = training.currentSplats();
    if (!cur) return;
    const some = await readSplats(device, cur, PREVIEW_SPLATS);
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

export async function run({ atom, inputs, log }) {
    if (!inputs?.assemble) throw new Error('train needs the assemble artifact');
    const tars = [].concat(inputs.frames ?? []).filter(Boolean);
    if (!tars.length) throw new Error('train needs at least one frame artifact');
    const files = readTar(inputs.assemble);
    const scene = JSON.parse(decoder.decode(files.get('scene.json')));
    const meshes = unpackMeshes(files.get('mesh.bin'), scene.meshes);
    const budget = Number(atom.params?.budget) || scene.budget;
    const iters = Number(atom.params?.iters) || 4000;
    const size = Number(atom.params?.size) || 1024;
    const { z, x, y } = scene.tile;
    const random = rngOf(atom, z, x, y);
    // Shuffled so any prefix is a fair sample: the preview reads a prefix.
    const share = Number(atom.params?.seed_share) || SEED_SHARE;
    const floor = atom.params?.ground_floor === undefined
        ? GROUND_FLOOR : Number(atom.params.ground_floor);
    const seed = shuffled(seedSurfaces(meshes, Math.round(budget * share), random,
        { spread: SPREAD, even: true, floor }), random);
    const set = atom.params?.camera_set;
    const ground = groundOf(files, scene);
    const eye = cameraSet(set, frameBounds(meshes), ground)[holdout(viewCount(set) || 1)[0]];
    log?.({ event: 'seeded', tile: scene.tile, splats: seed.count, ground_floor: floor,
        picture: pointsPicture(seed, eye) });

    const splats = await trainWithBrush({ atom, seed, tars, scene, eye, iters, budget, size, log });
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
            ground_floor: floor,
            dropped: splats.count - out.count,
        },
    };
}
