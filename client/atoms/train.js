// train.js — `train-v1`. The tile, learned from its own frames.
//
// `assemble` seeds a tile at 30 % of its budget by sampling the surfaces it
// built; `frame` renders that scene from a fixed camera set. This takes both
// and does what the initialisation cannot: moves, reshapes, recolours and grows
// the gaussians until they reproduce the frames. It is ordinary 3D-gaussian
// splatting — Adam over a differentiable rasteriser, with the MCMC variant's
// population control (client/lib/gsopt.js) — run in a Web Worker, on WebGPU
// where there is one.
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
import { bboxOf, readPly, writePly } from '../lib/ply.js';
import { readTar, writeTar } from '../lib/tar.js';
import { rngOf } from './assemble.js';

export const ALGO = 'train-v1';

// How often the population is maintained, and how much it may grow each time.
// Both are capped by the tile's budget, never by the loss (Invariant 8's
// structural rule on splat_count is what would reject a runaway).
export const MAINTAIN_EVERY = 100;
export const GROW = 0.12;
export const NOISE = 0.02;

const decoder = new TextDecoder();

function assembled(bytes) {
    const files = readTar(bytes);
    const scene = JSON.parse(decoder.decode(files.get('scene.json')));
    const init = files.get('init.ply');
    if (!init) throw new Error('the assemble artifact carries no init.ply');
    return { files, scene, model: Model.fromSplats(readPly(init)) };
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
    const { files, scene, model } = assembled(inputs.assemble);
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
            grow: GROW, noise: NOISE, maintainEvery: MAINTAIN_EVERY, log,
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
        },
    };
}
