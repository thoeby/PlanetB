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
// What the device said before it died: a WebGPU device that runs out of memory
// or fails validation does not throw where the mistake was — the next readback
// comes back as rubbish, or its map is rejected, and the runtime panics
// somewhere else entirely. Both are kept and put on the error the atom fails
// with, so the panel says what happened and not only where it landed.
let deviceErrors = [];

// What brush asks the device for, counted from the one place it can be:
// every queue.submit, every mapAsync (a GPU->CPU readback, and on the web a
// round trip through the event loop) with the time it took to come back, and
// every buffer created (Dawn zero-clears each on first use). Per step, these
// say where a step's time goes when the GPU is idle for most of it.
const stats = { submits: 0, cmdbufs: 0, maps: 0, mapMs: 0, allocs: 0, allocBytes: 0 };

// The counts since the last call, per `steps` steps.
export function deviceStats(steps = 1) {
    const out = {
        submits: +(stats.submits / steps).toFixed(1),
        maps: +(stats.maps / steps).toFixed(1),
        map_ms: +(stats.mapMs / steps).toFixed(0),
        allocs: +(stats.allocs / steps).toFixed(1),
        alloc_mb: +(stats.allocBytes / steps / 1048576).toFixed(1),
    };
    for (const k of Object.keys(stats)) stats[k] = 0;
    return out;
}

function countOn(device) {
    const submit = device.queue.submit.bind(device.queue);
    device.queue.submit = (bufs) => {
        stats.submits += 1;
        stats.cmdbufs += bufs?.length ?? 1;
        return submit(bufs);
    };
    const create = device.createBuffer.bind(device);
    device.createBuffer = (desc) => {
        stats.allocs += 1;
        stats.allocBytes += desc?.size ?? 0;
        const buf = create(desc);
        if (desc?.usage & 0x1) {                       // MAP_READ: a readback
            const map = buf.mapAsync.bind(buf);
            buf.mapAsync = async (...args) => {
                const t = performance.now();
                stats.maps += 1;
                try { return await map(...args); } finally { stats.mapMs += performance.now() - t; }
            };
        }
        return buf;
    };
}

// Everything the device complained about during this run, for the atom's
// error: the first few, whole. The first is usually the one that matters —
// "[Invalid ShaderModule] is invalid due to a previous error" is the second,
// and the previous error is the compiler saying which line it refused.
export function deviceTrouble() {
    return [lastPanic, ...deviceErrors].filter(Boolean).join(' · ');
}

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

// The vendored brush was built against a CubeCL that calls subgroupAdd and
// its kin without the `enable subgroups;` directive: the binary carries
// `enable f16;` and no other. Chromium shipped subgroups stable and made the
// directive mandatory, the browser updated, and every kernel of the sort and
// the reductions has failed to compile since —
//   "cannot call built-in function 'subgroupAdd' without extension 'subgroups'"
// — with the run going on regardless over rubbish. The device has the
// feature; the source lacks the line. It is put in front of any source that
// uses a subgroup builtin and does not already declare it, before Tint sees
// it. Until brush is rebuilt on a CubeCL that writes it (tools/build-brush.sh).
const SUBGROUP_USE = /\bsubgroup[A-Z]\w*\s*\(|@builtin\(\s*(?:subgroup_|num_subgroups)/;
const SUBGROUP_ENABLE = /^\s*enable\b[^;]*\bsubgroups\b/m;

export function withSubgroups(desc) {
    const code = desc?.code;
    if (typeof code !== 'string' || !SUBGROUP_USE.test(code) || SUBGROUP_ENABLE.test(code)) {
        return desc;
    }
    return { ...desc, code: `enable subgroups;\n${code}` };
}

// A device brush can train on: every feature and limit the adapter offers
// (its backward kernels want subgroups and big storage buffers). The one
// Chrome-experimental feature some adapters list and then refuse is left out.
//
// `timestamp-query` stays in, though CubeCL's timing of its autotune
// candidates is where two of this runtime's failures have landed. Withholding
// it does not stop CubeCL asking: it decides on the adapter's features and
// then createQuerySet throws outright, which is worse than the readback. If
// the timing path is the problem, tools/brush-autotune.patch is where to turn
// it off, not here.
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
    deviceErrors = [];
    countOn(device);
    // A device is lost for a reason — out of memory, a driver reset, a
    // validation failure the runtime did not check for — and the reason is
    // only ever said here.
    device.lost?.then?.((info) => {
        if (info?.reason !== 'destroyed') {
            deviceErrors.push(`the GPU device was lost (${info?.reason ?? 'unknown'})`
                + `${info?.message ? `: ${info.message}` : ''}`);
        }
    }).catch(() => {});
    device.addEventListener?.('uncapturederror', (ev) => {
        if (deviceErrors.length < 4) {
            deviceErrors.push(String(ev?.error?.message ?? ev?.error ?? '').slice(0, 1200));
        }
    });
    // A shader the compiler refuses is not an uncaptured error: the module
    // comes back invalid and everything built on it says "invalid due to a
    // previous error", and the previous error — the compiler naming the line
    // — is only ever in the module's own compilation info. brush creates its
    // modules on this device object, so its createShaderModule is wrapped to
    // read that info off every module and keep the first refusals.
    const create = device.createShaderModule.bind(device);
    device.createShaderModule = (desc) => {
        const mod = create(withSubgroups(desc));
        mod.getCompilationInfo?.().then((info) => {
            const bad = (info?.messages ?? []).filter((m) => m.type === 'error').slice(0, 3)
                .map((m) => `${desc?.label ?? 'shader'}:${m.lineNum}:${m.linePos} ${m.message}`);
            if (bad.length && deviceErrors.length < 6) deviceErrors.unshift(...bad);
        }).catch(() => {});
        return mod;
    };
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
        // The frames' alpha is where the tile is not (client/lib/raster.js):
        // masked, those pixels are left out of the loss, rather than
        // transparent, which would train them towards nothing.
        'alpha-mode': 'masked',
        'eval-split-every': null,
        'eval-every': iters * 10,
        'export-every': iters * 10,
        seed,
    };
}

// Drives a training run to its end. `config(init)` is handed what brush
// proposes for this dataset and returns the config to run with (configFor
// above). `onStep(iter, elapsedMs)` is how the atom beats its heartbeat; a
// Warning from brush is logged, not fatal.
//
// One step a call, and a macrotask between calls. brush's own app yields to
// the browser after every message it pulls off the stream
// (apps/brush-app/src/ui/ui_process.rs: "in the browser that doesn't yield
// back control fully though whereas yield_now() does" — a setTimeout(0)), and
// brush-js's trainSteps(n) pulls n steps' worth of messages with no yield in
// between. Pulled twenty at a time, the event loop never got a task between
// steps, and WebGPU's readback callbacks arrive as tasks: every step cost a
// scheduler wait rather than GPU time — the same 800 ms on a P2000, an M4000
// and a 4060 Ti, where the demo did 150. Everything brush says on the way —
// loading, the seed placed, kernels tuned — reaches the panel step by step.
export async function trainIn(app, dir, config,
    { steps = 1, onStep, onWarn, onBatch, onStage } = {}) {
    const { BrushMessageKind: K } = mod;
    const training = app.startTrainingFromDirectory(dir, async (init) => config(init));
    let done = false;
    let iter = 0;
    while (!done) {
        const msgs = await training.trainSteps(steps).catch((err) => {
            const said = deviceTrouble();
            throw new Error(`brush stopped at iteration ${iter}: ${err?.message ?? err}`
                + (said ? ` — ${said}` : ''));
        });
        if (!msgs.length) break;
        // A kernel this device refused to compile is refused for the whole
        // run: every render after it is rubbish and every gradient NaN, and
        // the run would go to its last step at full price and hand back
        // nothing. Stop at the first batch that saw it.
        if (deviceErrors.length) {
            throw new Error(`the GPU refused brush's kernels at iteration ${iter}: `
                + deviceTrouble());
        }
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
        // Between steps the run is idle, which is when a picture of it can
        // be taken (client/atoms/train.js) — and when the browser gets its
        // task back.
        await onBatch?.(iter, training);
        await new Promise((r) => setTimeout(r, 0));
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
