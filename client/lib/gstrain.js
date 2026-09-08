// gstrain.js — the training loop, and the CPU that can run it.
//
// One iteration is one view: render it, compare it to the frame `frame-v1`
// rendered from the same pose, push the error back through the splats and let
// Adam move them. Every so often the population is maintained — dead gaussians
// dropped, strong ones split, always under the tile's budget (gsopt.js).
//
// The loop knows nothing about where the arithmetic happens. A backend holds
// the model and the optimiser state and answers three things: load, step, save.
// client/lib/gsgpu.js is the WebGPU one; CpuBackend below is the reference, and
// what the node tests run.

import { backwardImage, backwardProject } from './gsgrad.js';
import { chainColor, lossGrad, zeros } from './gsmodel.js';
import { Adam, jitter, maintain } from './gsopt.js';
import { render, toRgba, toRgbaBytes } from './gsrast.js';
import { psnr } from './render.js';

// 3DGS's rates. Position is the only one that depends on how big the scene is,
// and the only one that decays.
export const LR = { pos: 1.6e-4, logScale: 5e-3, quat: 1e-3, sh: 2.5e-3, logit: 0.05 };
export const POS_DECAY = 0.01;

export const ratesFor = (extent) => ({ ...LR, pos: LR.pos * Math.max(extent, 1) });

export class CpuBackend {
    constructor(rates) { this.rates = rates; }

    load({ model, adam }) {
        this.model = model;
        this.adam = adam ?? new Adam(model.count, this.rates);
    }

    prepare() {}

    async step(view, lrScale) {
        const scene = this.model.scene();
        const image = render(view.cam, scene);
        const { loss, dLdRgb } = lossGrad(image.rgb, toFloat(view.rgb));
        const g = backwardImage(scene, image, dLdRgb);
        const grads = chainColor(g, scene, zeros(this.model.count));
        backwardProject(view.cam, scene, image.pre, g, grads);
        this.adam.step(this.model, grads, lrScale);
        return loss;
    }

    async render(cam) { return render(cam, this.model.scene()); }

    async save() { return { model: this.model, adam: this.adam }; }

    dispose() {}
}

// A frame is stored as bytes; the loss works in the same 0..1 the renderer does.
export function toFloat(rgb) {
    const out = new Float32Array(rgb.length);
    for (let i = 0; i < rgb.length; i++) out[i] = rgb[i] / 255;
    return out;
}

// The splats' own extent, which sets the position learning rate and the box
// they are pruned to.
export function boundsOf(model, margin = 0.1) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < model.count; i++) {
        for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k], model.pos[i * 3 + k]);
            hi[k] = Math.max(hi[k], model.pos[i * 3 + k]);
        }
    }
    const pad = hi.map((v, k) => (v - lo[k]) * margin);
    return { lo: lo.map((v, k) => v - pad[k]), hi: hi.map((v, k) => v + pad[k]),
        extent: Math.max(...hi.map((v, k) => v - lo[k])) / 2 };
}

// PSNR of one view the trainer never saw, in the 8-bit space the frames are
// stored in — the number WP3.1's acceptance is stated in.
export async function scoreOf(backend, views) {
    const scores = [];
    for (const view of views) {
        const image = await backend.render(view.cam);
        scores.push(psnr(toRgba(image), toRgbaBytes(view.rgb)));
    }
    return scores;
}

const shuffle = (n, random) => {
    const order = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
};

function round(state, opts, it) {
    const grow = it < opts.iters * 0.6 ? opts.grow : 0;
    const next = maintain(state.model, state.adam,
        { budget: opts.budget, bounds: opts.bounds, grow, random: opts.random });
    if (grow) jitter(next.model, opts.noise, opts.random);
    return next;
}

// Returns the trained model and what happened on the way there.
export async function train(backend, model, opts) {
    const { iters, views, random, log } = opts;
    let state = { model, adam: null };
    backend.prepare(views);
    backend.load(state);
    let order = shuffle(views.length, random);
    let count = model.count;
    let loss = 0;
    for (let it = 0; it < iters; it++) {
        if (it && it % opts.maintainEvery === 0) {
            state = round(await backend.save(), opts, it);
            count = state.model.count;
            backend.load(state);
        }
        if (it % views.length === 0) order = shuffle(views.length, random);
        const want = it % opts.logEvery === 0 || it === iters - 1;
        loss = await backend.step(views[order[it % views.length]],
            POS_DECAY ** (it / Math.max(iters - 1, 1)), want) || loss;
        if (want) log?.({ event: 'train', iter: it, loss, splats: count });
    }
    state = await backend.save();
    return { model: state.model, loss, iters };
}
