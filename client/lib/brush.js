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
import { yieldTask } from './quickyield.js';

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
const stats = { submits: 0, cmdbufs: 0, maps: 0, mapMs: 0, allocs: 0, allocBytes: 0,
    gpuMs: 0 };
// When the GPU last had nothing of ours left to do, so consecutive submits
// are not counted twice over: the busy time of a submit is from the later of
// its submission and the previous one's completion, to its completion.
let gpuIdleAt = 0;

// The counts since the last call, per `steps` steps. `gpu_ms` is how long
// the GPU was busy with what brush submitted — measured with
// onSubmittedWorkDone, so it is the device's own word — against the step's
// wall time: a step of 700 ms with 30 ms of it on the GPU is a step spent in
// the wasm, not in the kernels, and the other way round is the kernels.
export function deviceStats(steps = 1) {
    const out = {
        submits: Number((stats.submits / steps).toFixed(1)),
        gpu_ms: Number((stats.gpuMs / steps).toFixed(0)),
        maps: Number((stats.maps / steps).toFixed(1)),
        map_ms: Number((stats.mapMs / steps).toFixed(0)),
        allocs: Number((stats.allocs / steps).toFixed(1)),
        alloc_mb: Number((stats.allocBytes / steps / 1048576).toFixed(1)),
    };
    for (const k of Object.keys(stats)) stats[k] = 0;
    return out;
}

function countOn(device) {
    const submit = device.queue.submit.bind(device.queue);
    device.queue.submit = (bufs) => {
        stats.submits += 1;
        stats.cmdbufs += bufs?.length ?? 1;
        const at = performance.now();
        const out = submit(bufs);
        device.queue.onSubmittedWorkDone?.().then(() => {
            const done = performance.now();
            stats.gpuMs += done - Math.max(at, gpuIdleAt);
            gpuIdleAt = done;
        }).catch(() => {});
        return out;
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
// Brush's own schedule is left alone: how often it refines and how long it
// grows are what its app runs with, and its app, handed one of our datasets
// (tools/dataset.mjs), had the tile readable in a minute where this had
// blobs — with the same seed size (client/atoms/train.js SEED_SHARE) and no
// override. db/0138's shorter refine interval and db/0133's growth window
// were tuned for a 1 200-step run from a tenth of the budget and are
// history. An atom may still ask for a refine interval (db/0145).
//
// What is not touched here: `split-at-screen-size`. Raising it to let splats
// grow larger panics brush's own rasteriser — "num_intersections > max
// possible 4096" (crates/brush-render/src/render_aux.rs) — because that cap is
// what bounds how many splats a screen tile can hold. A splat that has to be
// bigger than the trainer will carry is widened after the run instead, where
// brush never renders it (client/atoms/train.js, `widen`).
// brush's own knobs an atom may turn (its `brush` param, db/0189): how hard
// it pulls splats smaller and fainter, and how readily it grows new ones.
// Anything else in that object is ignored.
const TUNABLE = ['scale-decay', 'opac-decay', 'growth-grad-threshold',
    'growth-select-fraction'];

export function configFor(init,
    { iters, budget, size, seed = 42, refineEvery = 0, tuning = {} }) {
    const tuned = Object.fromEntries(TUNABLE
        .filter((k) => Number.isFinite(tuning?.[k])).map((k) => [k, tuning[k]]));
    return {
        ...init,
        ...tuned,
        'total-train-iters': iters,
        'max-splats': budget,
        // How often brush looks for splats to split. It grows by a fraction of
        // what it has at each of these, so how many happen in the growth window
        // is what decides whether the budget is ever reached: at its own
        // default a 1 200-step run gets about five, which took a 22 500 seed to
        // 37 000 of a 600 000 budget — one splat per 77 m² of a z14 tile. Zero
        // leaves brush's own number alone.
        ...(refineEvery > 0 ? { 'refine-every': refineEvery } : {}),
        // The .sog keeps the DC colour only (client/lib/sogenc.js).
        'sh-degree': 0,
        'max-resolution': size,
        // The frames' alpha is where the tile is not (client/lib/raster.js),
        // and brush is left to read it the way its own app does with the
        // same folder: no mask file beside a frame, so `transparent` — those
        // pixels are trained towards nothing, and |alpha - 0| is in the loss
        // (brush-train's match-alpha-weight), which is what holds a splat at
        // the tile's edge to the tile. train-v10 to v16 said `masked`, which
        // leaves the void out of the loss altogether: a splat drifting over
        // the edge costs nothing there, and the edge came back smeared
        // outward while the app, on the same dataset, had a clean one.
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
// The yield is a channel post, not a timer: a background tab clamps timers
// to one a second (client/lib/quickyield.js).
export async function trainIn(app, dir, config,
    { steps = 1, onStep, onWarn, onBatch, onStage } = {}) {
    const { BrushMessageKind: K } = mod;
    const training = app.startTrainingFromDirectory(dir, async (init) => config(init));
    let done = false;
    let iter = 0;
    // Where a step's time goes: inside brush's trainSteps, or out here —
    // the preview, the log, the yield. Totals, so the caller can difference.
    const spent = { brush: 0, ours: 0 };
    let mark = performance.now();
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
        spent.brush += performance.now() - mark;
        mark = performance.now();
        for (const m of msgs) {
            if (m.kind === K.TrainStep) { iter = m.iter; onStep?.(m.iter, m.elapsedMs, spent); }
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
        await yieldTask();
        spent.ours += performance.now() - mark;
        mark = performance.now();
    }
    return training;
}

// Brush on a device this code makes (brushDevice above), because a device
// burn makes for itself on the web has no `timestamp-query`: CubeCL then
// times its autotune samples by a method that yields nothing on wasm, every
// sample "carried no measurement", and the tuner panicked at the first
// reduce. Every feature the adapter offers is what a tune needs. The splats
// come back through burn (tools/brush-readback.patch), so the device is
// held for nothing but this.
export async function brushApp(brush) {
    const { adapter, device } = await brushDevice();
    if (!adapter.features.has('timestamp-query')) {
        throw new Error('this GPU offers no timestamp-query, which brush needs to tune with');
    }
    const app = new brush.BrushApp();
    app.initExisting(adapter, device, device.queue);
    return { app, device };
}

// The splats as brush holds them, off its GPU through burn
// (tools/brush-readback.patch): transforms [N, 10] as means(3) |
// rotation xyzw(4) | log scales(3), sh [N, (deg+1)^2, 3], raw opacities [N].
export async function readSplats(splats, limit = Infinity) {
    if (typeof splats.read !== 'function') {
        throw new Error('this brush build has no read(): run tools/build-brush.sh');
    }
    const r = await splats.read(Number.isFinite(limit) ? limit : 0xffffffff);
    return splatsFromBrush({ transforms: r.transforms, sh: r.sh, opac: r.opac,
        count: r.count, coeffs: (r.shDegree + 1) ** 2 });
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
