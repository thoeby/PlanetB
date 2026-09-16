// brush.js — the trainer: brush (Apache-2.0, github.com/ArthurBrussee/brush),
// as WebAssembly on WebGPU, vendored under client/vendor/brush by
// tools/build-brush.sh.
//
// train-v1 and v2 were a 3DGS trainer written here from the paper; nobody had
// run it on a real GPU. brush is the same optimisation done by people who do
// nothing else — SSIM in the loss, densification, faster kernels — and it takes
// exactly what `frame` already writes: nerfstudio's transforms.json with poses
// fixed, plus a ply to start from. This file is the seam: a GPU device brush
// can share, a config in brush's own names, the message pump, and the splats
// read back off the GPU into the arrays client/lib/ply.js writes.

import { SH_C0, emptySplats } from './ply.js';
import { sigmoid } from './gsmath.js';

let mod = null;
// The last thing brush's panic hook wrote: a Rust panic reaches JS as
// "RuntimeError: unreachable", and the reason went to console.error in the
// worker where nobody looks. It is kept and put on the error instead.
let lastPanic = '';

export async function loadBrush() {
    if (mod) return mod;
    const orig = console.error.bind(console);
    console.error = (...args) => {
        const text = args.map(String).join(' ');
        if (text.includes('panicked')) lastPanic = text.slice(0, 600);
        orig(...args);
    };
    const m = await import('../vendor/brush/brush_js.js').catch(() => {
        throw new Error('brush is not vendored: run tools/build-brush.sh (needs Rust)');
    });
    await m.default();
    mod = m;
    return mod;
}

// A device brush can train on: every feature and limit the adapter offers
// (its backward kernels want subgroups and big storage buffers). The one
// Chrome-experimental feature some adapters list and then refuse is left out.
export async function brushDevice(gpu = globalThis.navigator?.gpu) {
    const adapter = await gpu?.requestAdapter?.({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no WebGPU adapter: training needs one');
    // Its sort and backward kernels are written on subgroups; without them
    // the shaders do not validate and brush panics some way in. Say so here.
    if (!adapter.features.has('subgroups')) {
        throw new Error('this GPU offers no subgroups, which brush needs to train');
    }
    const requiredFeatures = [...adapter.features].filter((f) => f !== 'mappable-primary-buffers');
    const requiredLimits = {};
    for (const k in adapter.limits) {
        if (typeof adapter.limits[k] === 'number') requiredLimits[k] = adapter.limits[k];
    }
    const device = await adapter.requestDevice({ requiredFeatures, requiredLimits });
    return { adapter, device };
}

// brush's TrainStreamConfig, in its kebab-case names, over what it proposed.
// The seed is most of the budget on the surface (client/atoms/train.js) and
// brush densifies towards max-splats — the budget — for the first part of the
// run: splitting where the picture is still wrong is what puts small splats
// on edges, and a seed of uniform discs has none. No eval split: verify holds
// its own poses back.
//
// What is not touched here: `split-at-screen-size`. Raising it to let splats
// grow larger panics brush's own rasteriser — "num_intersections > max
// possible 4096" (crates/brush-render/src/render_aux.rs) — because that cap is
// what bounds how many splats a screen tile can hold. A splat that has to be
// bigger than the trainer will carry is widened after the run instead, where
// brush never renders it (client/atoms/train.js, `widen`).
export function configFor(init, { iters, budget, size, seed = 42 }) {
    return {
        ...init,
        'total-train-iters': iters,
        'max-splats': budget,
        'sh-degree': 0,
        'growth-start-iter': 0,
        'growth-stop-iter': Math.round(iters * 0.6),
        'max-resolution': size,
        'eval-split-every': null,
        'eval-every': iters * 10,
        'export-every': iters * 10,
        seed,
    };
}

// Drives a training run to its end. `config(init)` is handed what brush
// proposes for this dataset and returns the config to run with (configFor
// above). `onStep(iter, elapsedMs)` is how the atom
// beats its heartbeat; a Warning from brush is logged, not fatal.
// `steps` a call: trainSteps returns only once that many steps have run, and
// everything brush says on the way — loading, the seed placed, kernels tuned
// — comes back with it. The first call asks for one step, so those reach the
// panel before minutes of the first steps on a slow card, not after.
export async function trainIn(app, dir, config,
    { steps = 20, onStep, onWarn, onBatch, onStage } = {}) {
    const { BrushMessageKind: K } = mod;
    const training = app.startTrainingFromDirectory(dir, async (init) => config(init));
    let done = false;
    let iter = 0;
    while (!done) {
        const msgs = await training.trainSteps(iter ? steps : 1).catch((err) => {
            throw new Error(`brush stopped at iteration ${iter}: ${err?.message ?? err}`
                + (lastPanic ? ` — ${lastPanic}` : ''));
        });
        if (!msgs.length) break;
        for (const m of msgs) {
            if (m.kind === K.TrainStep) { iter = m.iter; onStep?.(m.iter, m.elapsedMs); }
            else if (m.kind === K.Warning) onWarn?.(m.text);
            else if (m.kind === K.DoneTraining) done = true;
            else if (m.kind === K.StartLoading) onStage?.('loading the frames');
            else if (m.kind === K.DatasetLoaded) {
                onStage?.(`${m.trainViews} views loaded, placing the seed`);
            } else if (m.kind === K.SplatsUpdated && !iter) {
                onStage?.(`${m.numSplats} splats placed, tuning the kernels for this GPU`);
            }
            m.free?.();
        }
        // Between batches the run is idle, which is when a picture of it can
        // be taken (client/atoms/train.js).
        await onBatch?.(iter, training);
    }
    return training;
}

async function readBuffer(device, src, bytes) {
    // MAP_READ | COPY_DST, and READ: the WebGPU constants, spelled out so
    // this file also loads where there is no GPU (the node tests).
    const staging = device.createBuffer({ size: bytes, usage: 0x1 | 0x8 });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, staging, 0, bytes);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(0x1);
    const out = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return out;
}

// The splats as brush holds them, off its GPU: transforms [N, 10] as
// means(3) | rotation xyzw(4) | log scales(3), sh [N, (deg+1)^2, 3], and raw
// opacities [N]. Bound whole by brush's own demo, so offset 0.
export async function readSplats(device, splats, limit = Infinity) {
    const n = Math.min(splats.numSplats, limit);
    const coeffs = (splats.shDegree + 1) ** 2;
    const b = splats.buffers();
    if (!b) throw new Error('brush is not on WebGPU: no buffers to read');
    const [transforms, sh, opac] = await Promise.all([
        readBuffer(device, b.transforms, n * 10 * 4),
        readBuffer(device, b.shCoeffs, n * coeffs * 3 * 4),
        readBuffer(device, b.rawOpacities, n * 4),
    ]);
    return splatsFromBrush({ transforms, sh, opac, count: n, coeffs });
}

// Pure, so client/test/brush.test.js can check the layout without a GPU.
export function splatsFromBrush({ transforms, sh, opac, count, coeffs }) {
    const f = emptySplats(count);
    for (let i = 0; i < count; i++) {
        const t = i * 10;
        f.x[i] = transforms[t]; f.y[i] = transforms[t + 1]; f.z[i] = transforms[t + 2];
        f.qx[i] = transforms[t + 3]; f.qy[i] = transforms[t + 4];
        f.qz[i] = transforms[t + 5]; f.qw[i] = transforms[t + 6];
        f.sx[i] = Math.exp(transforms[t + 7]);
        f.sy[i] = Math.exp(transforms[t + 8]);
        f.sz[i] = Math.exp(transforms[t + 9]);
        const s = i * coeffs * 3;
        f.r[i] = 0.5 + SH_C0 * sh[s];
        f.g[i] = 0.5 + SH_C0 * sh[s + 1];
        f.b[i] = 0.5 + SH_C0 * sh[s + 2];
        f.a[i] = sigmoid(opac[i]);
    }
    return f;
}

// What stays: inside the tile's box and not transparent. The rest is a splat
// that wandered out of this tile's business (db/0015_structural.sql checks
// the bbox of what comes back) or one that went out.
export function keep(f, lo, hi, minAlpha = 1 / 255) {
    const rows = [];
    for (let i = 0; i < f.count; i++) {
        const p = [f.x[i], f.y[i], f.z[i]];
        const inside = p.every((v, k) => v >= lo[k] && v <= hi[k]);
        if (inside && f.a[i] >= minAlpha && p.every(Number.isFinite)) rows.push(i);
    }
    const out = emptySplats(rows.length);
    for (const k of Object.keys(out)) {
        if (k === 'count') continue;
        for (let n = 0; n < rows.length; n++) out[k][n] = f[k][rows[n]];
    }
    return out;
}
