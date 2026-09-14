// train.js — `train-v2`. The tile, learned from its own frames.
//
// `assemble` built the surfaces and `frame` rendered them from a fixed camera
// set. Unlike a photographed scene there is nothing to discover here: the
// geometry the frames show is in the tar, so the tile is seeded by sampling
// those surfaces at its whole budget (client/lib/sampling.js) and training only
// has to find colour, opacity and size. Positions are held still for the first
// part of the run and then freed to settle; nothing grows, and the population
// is only pruned. It is ordinary 3D-gaussian splatting otherwise — Adam over a
// differentiable rasteriser (client/lib/gsopt.js) — run in a Web Worker, on
// WebGPU where there is one.
//
// train-v1 started from 30 % of the budget and grew towards it with MCMC
// relocation, which is the paper's recipe for a sparse structure-from-motion
// start. It cost 7 000 iterations to arrive where this starts.
//
// Four poses are held back (client/lib/frames.js): the PSNR reported here is
// measured on views the optimiser never saw, and `verify` re-renders two of the
// same four in another tab. Invariant 8: this is probabilistic quality
// assurance, not proof.

import { viewCount } from '../lib/cameras.js';
import { decodeImage } from '../lib/geo.js';
import { holdout, loadFrames, TRAIN_SIZE } from '../lib/frames.js';
import { gpuBackend, gpuDevice } from '../lib/gsgpu.js';
import { Model } from '../lib/gsmodel.js';
import { CpuBackend, boundsOf, ratesFor, scoreOf, train } from '../lib/gstrain.js';
import { unpackMeshes } from '../lib/mesh.js';
import { bboxOf, writePly } from '../lib/ply.js';
import { rngOf, sampleSurfaces } from '../lib/sampling.js';
import { readTar, writeTar } from '../lib/tar.js';

export const ALGO = 'train-v2';

// The population is only pruned, every MAINTAIN_EVERY iterations: nothing
// grows, so nothing can pass the budget it was seeded at (Invariant 8's
// structural rule on splat_count is what would reject it if it did). A
// maintenance round is a full round trip of the model through the CPU, which
// is why it is rare.
export const MAINTAIN_EVERY = 500;
export const GROW = 0;
export const NOISE = 0;
// The share of the run positions are held still for. The seed is already on
// the surface; letting it drift before the colours have settled only smears.
export const FREEZE = 0.4;
// In-plane radius of a seed splat as a share of its spacing: overlapping, so
// the first render is a surface and not a sieve (client/atoms/sample.js).
export const SPREAD = 1.15;

const decoder = new TextDecoder();

// The seed: the assembled surfaces, sampled at the tile's whole budget with
// the atom's own seed, so two trainers of one atom start from the same splats.
function assembled(bytes, atom) {
    const files = readTar(bytes);
    const scene = JSON.parse(decoder.decode(files.get('scene.json')));
    const bin = files.get('mesh.bin');
    if (!bin || !scene.meshes) throw new Error('the assemble artifact carries no mesh');
    const meshes = unpackMeshes(bin, scene.meshes);
    const budget = Number(atom.params?.budget) || scene.budget;
    const { z, x, y } = scene.tile;
    const splats = sampleSurfaces(meshes, budget, rngOf(atom, z, x, y), { spread: SPREAD });
    return { files, scene, model: Model.fromSplats(splats) };
}

// A trained tile is still a tile: it carries the ground the player walks on and
// the boxes they bump into, straight through from `assemble`, so `sog` can put
// them beside the .sog (client/atoms/sog.js).
function pack(model, files) {
    return writeTar([
        { name: 'splats.ply', bytes: writePly(model.toSplats()) },
        { name: 'height.r16', bytes: files.get('height.r16') },
        { name: 'colliders.json', bytes: files.get('colliders.json') },
        { name: 'scene.json', bytes: files.get('scene.json') },
    ]);
}

const finite = (model) => ['pos', 'logScale', 'quat', 'sh', 'logit']
    .every((k) => model[k].every(Number.isFinite));

// PSNR is capped rather than infinite: JSON has no infinity, and a pair of
// identical pictures is not a more interesting result than a very good one.
const mean = (xs) => (xs.length
    ? xs.reduce((s, v) => s + Math.min(v, 99), 0) / xs.length : 0);

async function backendFor(rates, size, log) {
    const device = await gpuDevice();
    if (!device) {
        log?.({ event: 'no-webgpu', note: 'training on the CPU, which is slow' });
        return { backend: new CpuBackend(rates), kind: 'cpu' };
    }
    return { backend: await gpuBackend(device, rates, { width: size, height: size }),
        kind: 'webgpu' };
}

export async function run({ atom, inputs, canvas, log }) {
    if (!inputs?.assemble) throw new Error('train needs the assemble artifact');
    const tars = [].concat(inputs.frames ?? []).filter(Boolean);
    if (!tars.length) throw new Error('train needs at least one frame artifact');
    const { files, scene, model } = assembled(inputs.assemble, atom);
    const size = Number(atom.params?.size) || TRAIN_SIZE;
    const all = await loadFrames(tars, { decode: (b) => decodeImage(b, canvas), size });
    // The held-out poses are a property of the camera set, not of the frames
    // this atom happened to be handed, or `verify` would hold back others.
    const back = new Set(holdout(viewCount(atom.params?.camera_set) || all.views.length));
    const views = all.views.filter((v) => !back.has(v.id));
    const held = all.views.filter((v) => back.has(v.id));
    if (!views.length) throw new Error('every frame was held out; the set is too small');

    const bounds = boundsOf(model, 0.15);
    const { backend, kind } = await backendFor(ratesFor(bounds.extent), size, log);
    // What the initialisation alone is worth, on the same held-out poses: the
    // difference is what this atom did, and the only quality number that means
    // anything without a reference implementation to compare against.
    let before, out, scores;
    try {
        backend.load({ model });
        before = await scoreOf(backend, held);
        log?.({ event: 'training', tile: scene.tile, on: kind, views: views.length,
            held: held.length, from: model.count, psnr: mean(before) });
        out = await train(backend, model, {
            iters: Number(atom.params?.iters) || 5000, views, bounds,
            budget: Number(atom.params?.budget) || model.count,
            random: rngOf(atom, scene.tile.z, scene.tile.x, scene.tile.y),
            grow: GROW, noise: NOISE, maintainEvery: MAINTAIN_EVERY, freeze: FREEZE, log,
            logEvery: Math.max(5, Math.round((Number(atom.params?.iters) || 5000) / 25)),
        });
        scores = await scoreOf(backend, held);
    } finally {
        backend.dispose();      // the buffers go whether training finished or threw
    }
    if (!finite(out.model)) throw new Error('training diverged: the model is not finite');

    const tar = pack(out.model, files);
    log?.({ event: 'trained', tile: scene.tile, splats: out.model.count,
        psnr: Number(mean(scores).toFixed(2)) });
    return {
        files: [{ ext: 'tar', kind: 'ply', algo_version: ALGO, bytes: tar }],
        output: 'tar',
        result: {
            bytes: tar.length, splat_count: out.model.count, finite: true,
            bbox: bboxOf(out.model.toSplats()), origin: scene.origin, tile: scene.tile,
            psnr: mean(scores), psnr_before: mean(before),
            psnr_views: scores.map((v, i) => ({ pose: held[i].id, psnr: v })),
            iters: out.iters, loss: out.loss, backend: kind, frame_size: size,
            // Splats a screen tile could not hold (client/lib/gsgpu.js
            // CAPACITY): rendered nowhere and taught nothing, so a number here
            // means the tile was denser than the trainer could see.
            dropped: out.dropped ?? 0,
        },
    };
}
