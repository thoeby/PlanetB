// gsgpu.js — the trainer on the GPU.
//
// The same nine kernels client/lib/gsrast.js and client/lib/gsgrad.js are in
// JS, driven from here: preprocess, sort each tile's list, render, take the
// loss, walk it back, project it onto the parameters, step Adam. One submit per
// iteration, and nothing crosses back to the CPU except when the loop asks for
// the model — which is why the model and the optimiser's moments both live on
// the device between maintenance rounds.
//
// Everything the shaders read is a plain storage buffer of f32; there are no
// textures, because a frame is data here, not a picture.

import { Adam } from './gsopt.js';
import { FIELDS, Model, WIDTH } from './gsmodel.js';
import { COMMON, PREPROCESS, RENDER, SORT, STRIDE, TILE } from './gswgsl.js';
import { ADAM, BACKWARD, CLEAR, LOSS, PARAMS, PROJECT, SLOTS }
    from './gswgslgrad.js';

export const CAPACITY = 1024;      // splats per 16x16 tile; the sort's array size
const OFFSET = { pos: 0, logScale: 3, quat: 6, sh: 10, logit: 13 };

// The backend, with its shaders checked. Anything that means to train should
// come through here rather than construct one directly.
export async function gpuBackend(device, rates, size) {
    return new GpuBackend(device, rates, size).validate();
}

export async function gpuDevice(gpu = globalThis.navigator?.gpu) {
    const adapter = await gpu?.requestAdapter?.().catch(() => null);
    if (!adapter) return null;
    const want = ['maxStorageBufferBindingSize', 'maxBufferSize',
        'maxComputeWorkgroupStorageSize'];
    const requiredLimits = {};
    for (const k of want) requiredLimits[k] = adapter.limits[k];
    return adapter.requestDevice({ requiredLimits }).catch(() => null);
}

const STORAGE = 0x80 | 0x8 | 0x4;   // STORAGE | COPY_DST | COPY_SRC

export class GpuBackend {
    constructor(device, rates, { width, height, capacity = CAPACITY }) {
        this.device = device;
        this.rates = rates;
        this.size = { width, height, capacity,
            tx: Math.ceil(width / TILE), ty: Math.ceil(height / TILE) };
        this.buf = {};
        this.pipes = {};
        this.modules = {};
        this.build();
    }

    module(name, code) {
        const mod = this.device.createShaderModule({
            code: (COMMON + code).replace(/\$\{CAP\}/g, String(this.size.capacity))
                .replace(/\$\{TILE\}/g, String(TILE)),
        });
        this.modules[name] = mod;
        return mod;
    }

    // A shader that does not compile is not an error anyone sees: the pipeline
    // is invalid, the dispatch is dropped, and the buffer it should have
    // written comes back full of zeros. Ask before trusting any of it.
    async validate() {
        const bad = [];
        for (const [name, mod] of Object.entries(this.modules)) {
            for (const m of (await mod.getCompilationInfo()).messages) {
                if (m.type === 'error') bad.push(`${name}:${m.lineNum} ${m.message}`);
            }
        }
        if (bad.length) throw new Error(`the trainer's shaders: ${bad.join('; ')}`);
        return this;
    }

    build() {
        const kernels = { preprocess: PREPROCESS, sort: SORT, render: RENDER, loss: LOSS,
            backward: BACKWARD, project: PROJECT, adam: ADAM, clear: CLEAR };
        for (const [name, code] of Object.entries(kernels)) {
            this.pipes[name] = this.device.createComputePipeline({
                layout: 'auto',
                compute: { module: this.module(name, code), entryPoint: 'main' },
            });
        }
        const { width: w, height: h, tx, ty, capacity } = this.size;
        this.alloc('tileCount', tx * ty * 4);
        this.alloc('tileItems', tx * ty * capacity * 4);
        this.alloc('image', w * h * 3 * 4);
        this.alloc('rest', w * h * 4);
        this.alloc('last', w * h * 4);
        this.alloc('dL', w * h * 3 * 4);
        // Empty until prepare(), but load() builds every bind group and a bind
        // group with a missing buffer is a "Required member is undefined".
        this.alloc('targets', 4);
        this.buf.cam = this.device.createBuffer({ size: 96, usage: 0x40 | 0x8 });
        this.buf.opt = this.device.createBuffer({ size: 48, usage: 0x40 | 0x8 });
    }

    alloc(name, bytes) {
        this.buf[name]?.destroy();
        this.buf[name] = this.device.createBuffer({ size: Math.max(bytes, 4), usage: STORAGE });
    }

    // Every view's target, packed as bytes, uploaded once. A step names its own
    // by an offset, so nothing but the uniform changes between iterations.
    prepare(views) {
        const stride = views.length ? (views[0].rgb.length + 3) & ~3 : 4;
        const all = new Uint8Array(Math.max(stride * views.length, 4));
        views.forEach((v, i) => { all.set(v.rgb, i * stride); v.base = i * stride; });
        this.alloc('targets', all.byteLength);
        this.device.queue.writeBuffer(this.buf.targets, 0, all);
    }

    load({ model, adam }) {
        this.count = model.count;
        this.adamState = adam ?? new Adam(model.count, this.rates);
        for (const k of FIELDS) {
            this.alloc(k, model.count * WIDTH[k] * 4);
            this.device.queue.writeBuffer(this.buf[k], 0, model[k]);
        }
        this.alloc('pre', model.count * STRIDE * 4);
        this.alloc('gscreen', model.count * SLOTS * 4);
        this.alloc('gparam', model.count * PARAMS * 4);
        this.alloc('mom', model.count * PARAMS * 4);
        this.alloc('vel', model.count * PARAMS * 4);
        this.device.queue.writeBuffer(this.buf.mom, 0, flatten(this.adamState.m, model.count));
        this.device.queue.writeBuffer(this.buf.vel, 0, flatten(this.adamState.v, model.count));
        this.groups = bindAll(this.device, this.pipes, this.buf);
    }

    camUniform(cam, base = 0) {
        const f = new Float32Array(24);
        const u = new Uint32Array(f.buffer);
        for (let r = 0; r < 3; r++) f.set(cam.w.slice(r * 3, r * 3 + 3), r * 4);
        f.set(cam.t, 12);
        [f[3], f[7], f[11], f[15]] = [cam.fx, cam.fy, cam.cx, cam.cy];
        [u[16], u[17], u[18], u[19]] = [this.size.width, this.size.height, this.size.tx,
            this.count];
        [f[20], f[21], f[23]] = [cam.near, this.size.capacity, base];
        this.device.queue.writeBuffer(this.buf.cam, 0, f);
    }

    optUniform(lrScale) {
        const a = this.adamState;
        a.t += 1;
        const f = new Float32Array(12);
        const r = a.lr;
        f.set([r.pos, r.logScale, r.quat, r.sh], 0);
        f.set([r.logit, 1 - a.opts.beta1 ** a.t, 1 - a.opts.beta2 ** a.t, lrScale], 4);
        f.set([a.opts.beta1, a.opts.beta2, a.opts.eps, 0], 8);
        this.device.queue.writeBuffer(this.buf.opt, 0, f);
    }

    forward(enc, cam, base) {
        this.camUniform(cam, base);
        enc.clearBuffer(this.buf.tileCount);
        const p = enc.beginComputePass();
        run(p, this.pipes.preprocess, this.groups.preprocess, ceil(this.count, 64));
        run(p, this.pipes.sort, this.groups.sort, this.size.tx * this.size.ty);
        run(p, this.pipes.render, this.groups.render, this.size.tx, this.size.ty);
        p.end();
    }

    async step(view, lrScale, wantLoss = false) {
        const enc = this.device.createCommandEncoder();
        this.forward(enc, view.cam, view.base ?? 0);
        enc.clearBuffer(this.buf.gscreen);
        this.optUniform(lrScale);
        const p = enc.beginComputePass();
        run(p, this.pipes.loss, this.groups.loss,
            ceil(this.size.width * this.size.height * 3, 64));
        run(p, this.pipes.backward, this.groups.backward, this.size.tx, this.size.ty);
        run(p, this.pipes.project, this.groups.project, ceil(this.count, 64));
        run(p, this.pipes.adam, this.groups.adam, ceil(this.count, 64));
        p.end();
        this.device.queue.submit([enc.finish()]);
        return wantLoss ? this.lossOf(view) : 0;
    }

    async lossOf(view) {
        const rgb = await this.read('image', this.size.width * this.size.height * 3 * 4);
        const px = new Float32Array(rgb);
        let sum = 0;
        for (let i = 0; i < px.length; i++) {
            const e = px[i] - view.rgb[i] / 255;
            sum += 0.8 * Math.abs(e) + 0.2 * e * e;
        }
        return sum / px.length;
    }

    async render(cam) {
        const enc = this.device.createCommandEncoder();
        this.forward(enc, cam, 0);
        this.device.queue.submit([enc.finish()]);
        const bytes = await this.read('image', this.size.width * this.size.height * 3 * 4);
        return { rgb: new Float32Array(bytes), width: this.size.width,
            height: this.size.height };
    }

    async read(name, bytes) {
        const staging = this.device.createBuffer({ size: bytes, usage: 0x1 | 0x8 });
        const enc = this.device.createCommandEncoder();
        enc.copyBufferToBuffer(this.buf[name], 0, staging, 0, bytes);
        this.device.queue.submit([enc.finish()]);
        await staging.mapAsync(1);
        const copy = staging.getMappedRange().slice(0);
        staging.unmap();
        staging.destroy();
        return copy;
    }

    async save() {
        const model = new Model(this.count);
        for (const k of FIELDS) {
            model[k].set(new Float32Array(
                await this.read(k, this.count * WIDTH[k] * 4)));
        }
        const adam = new Adam(this.count, this.rates, this.adamState.opts);
        adam.t = this.adamState.t;
        unflatten(new Float32Array(await this.read('mom', this.count * PARAMS * 4)), adam.m);
        unflatten(new Float32Array(await this.read('vel', this.count * PARAMS * 4)), adam.v);
        this.adamState = adam;
        return { model, adam };
    }

    dispose() {
        for (const b of Object.values(this.buf)) b.destroy();
    }
}

const ceil = (n, d) => Math.max(1, Math.ceil(n / d));

function run(pass, pipeline, group, x, y = 1) {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(x, y);
}

// The shaders see one row of 14 per gaussian; Adam keeps a typed array per
// field, because that is what the CPU backend and maintenance work in.
function flatten(state, count) {
    const out = new Float32Array(count * PARAMS);
    for (const k of FIELDS) {
        for (let i = 0; i < count; i++) {
            for (let c = 0; c < WIDTH[k]; c++) {
                out[i * PARAMS + OFFSET[k] + c] = state[k][i * WIDTH[k] + c];
            }
        }
    }
    return out;
}

function unflatten(flat, state) {
    const count = flat.length / PARAMS;
    for (const k of FIELDS) {
        for (let i = 0; i < count; i++) {
            for (let c = 0; c < WIDTH[k]; c++) {
                state[k][i * WIDTH[k] + c] = flat[i * PARAMS + OFFSET[k] + c];
            }
        }
    }
}

const LAYOUT = {
    preprocess: ['pos', 'logScale', 'quat', 'sh', 'logit', 'pre', 'tileCount', 'tileItems',
        'cam'],
    sort: ['pre', 'tileCount', 'tileItems', 'cam'],
    render: ['pre', 'tileCount', 'tileItems', 'image', 'rest', 'last', 'cam'],
    loss: ['image', 'targets', 'dL', 'cam'],
    backward: ['pre', 'tileCount', 'tileItems', 'rest', 'last', 'dL', 'gscreen', 'cam'],
    project: ['pre', 'gscreen', 'logScale', 'quat', 'gparam', 'cam'],
    adam: ['pos', 'logScale', 'quat', 'sh', 'logit', 'gparam', 'mom', 'vel', 'opt'],
    clear: ['gscreen'],
};

function bindAll(device, pipes, buf) {
    const groups = {};
    for (const [name, names] of Object.entries(LAYOUT)) {
        const missing = names.find((b) => !buf[b]);
        if (missing) throw new Error(`${name} wants a ${missing} buffer and has none`);
        groups[name] = device.createBindGroup({
            layout: pipes[name].getBindGroupLayout(0),
            entries: names.map((b, i) => ({ binding: i, resource: { buffer: buf[b] } })),
        });
    }
    return groups;
}
