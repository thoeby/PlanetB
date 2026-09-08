// gsopt.js — Adam, and the population control that goes with it.
//
// Training a tile is not only gradient descent: gaussians that have gone
// transparent are worth nothing where they are, and a tile that starts from
// 30 % of its budget (client/atoms/assemble.js) has room to grow. This is the
// MCMC variant of that — dead gaussians are relocated onto live ones rather
// than deleted and re-seeded, positions are given noise so the sampler explores,
// and growth is capped by the tile's budget, never by a heuristic that could run
// away.
//
// Everything here is driven by a seeded random number generator, so the same
// atom run twice takes the same decisions.

import { FIELDS, WIDTH, zeros } from './gsmodel.js';
import { sigmoid } from './gsmath.js';

export const DEAD = 0.05;          // opacity below which a gaussian is not there

export class Adam {
    constructor(count, lr, { beta1 = 0.9, beta2 = 0.999, eps = 1e-8 } = {}) {
        this.count = count;
        this.lr = lr;
        this.opts = { beta1, beta2, eps };
        this.m = zeros(count);
        this.v = zeros(count);
        this.t = 0;
    }

    step(model, grads, scale = 1) {
        this.t += 1;
        const { beta1, beta2, eps } = this.opts;
        const bc1 = 1 - beta1 ** this.t;
        const bc2 = 1 - beta2 ** this.t;
        for (const k of FIELDS) {
            const [p, g, m, v] = [model[k], grads[k], this.m[k], this.v[k]];
            const rate = (this.lr[k] ?? 0) * (k === 'pos' ? scale : 1);
            for (let i = 0; i < p.length; i++) {
                m[i] = beta1 * m[i] + (1 - beta1) * g[i];
                v[i] = beta2 * v[i] + (1 - beta2) * g[i] * g[i];
                p[i] -= rate * (m[i] / bc1) / (Math.sqrt(v[i] / bc2) + eps);
            }
        }
        model.touch();
    }

    // Rows move with the model; a relocated gaussian starts fresh, which is
    // what stops it inheriting the momentum of the one it replaced.
    select(keep) {
        const next = new Adam(keep.length, this.lr, this.opts);
        next.t = this.t;
        for (const k of FIELDS) {
            const w = WIDTH[k];
            for (let n = 0; n < keep.length; n++) {
                if (keep[n] < 0) continue;
                next.m[k].set(this.m[k].subarray(keep[n] * w, keep[n] * w + w), n * w);
                next.v[k].set(this.v[k].subarray(keep[n] * w, keep[n] * w + w), n * w);
            }
        }
        return next;
    }
}

// Alive, and inside the tile: a gaussian that has drifted out of the bounds the
// job compiled is not this tile's business (db/0015_structural.sql checks the
// bounding box of what comes back).
export function alive(model, bounds) {
    const keep = [];
    for (let i = 0; i < model.count; i++) {
        const p = model.pos.subarray(i * 3, i * 3 + 3);
        const inside = p.every((v, k) => v >= bounds.lo[k] && v <= bounds.hi[k]);
        if (inside && sigmoid(model.logit[i]) >= DEAD) keep.push(i);
    }
    return keep;
}

const pick = (cdf, r) => {
    let lo = 0;
    let hi = cdf.length - 1;
    const t = r * cdf[hi];
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
};

// Sampling weights: a gaussian that is carrying the image is worth copying.
function cdfOf(model, rows) {
    const cdf = new Float64Array(rows.length);
    let sum = 0;
    for (let n = 0; n < rows.length; n++) {
        sum += Math.max(1e-6, sigmoid(model.logit[rows[n]]));
        cdf[n] = sum;
    }
    return cdf;
}

// Two gaussians in one place should look like the one they came from, so both
// take the opacity that composites to the original: 1 - sqrt(1 - o).
function halve(model, dst, src, random) {
    for (const k of FIELDS) {
        const w = WIDTH[k];
        model[k].set(model[k].subarray(src * w, src * w + w), dst * w);
    }
    const o = sigmoid(model.logit[src]);
    const split = Math.log(1 / (1 - Math.sqrt(Math.max(1e-6, 1 - o))) - 1);
    model.logit[src] = -split;
    model.logit[dst] = -split;
    for (let k = 0; k < 3; k++) {
        const s = Math.exp(model.logScale[src * 3 + k]);
        model.pos[dst * 3 + k] += (random() - 0.5) * 2 * s;
    }
}

// One maintenance round: drop what is dead or gone, grow towards the budget by
// splitting the strongest, and never exceed it (Invariant 8's structural rule
// on splat_count is what would reject the atom otherwise).
export function maintain(model, adam, { budget, bounds, grow, random }) {
    const keep = alive(model, bounds);
    if (!keep.length) return { model, adam, dropped: 0, grown: 0 };
    const room = Math.max(0, Math.min(budget, Math.round(keep.length * (1 + grow)))
        - keep.length);
    const rows = keep.concat(new Array(room).fill(-1));
    const next = model.select(rows.map((r) => Math.max(r, 0)));
    const cdf = cdfOf(model, keep);
    for (let n = keep.length; n < rows.length; n++) {
        halve(next, n, pick(cdf, random()), random);
    }
    next.touch();
    return { model: next, adam: adam.select(rows), dropped: model.count - keep.length,
        grown: room };
}

// The MCMC half: a nudge proportional to how little a gaussian is contributing,
// so the transparent ones wander instead of sitting where they failed.
export function jitter(model, amount, random) {
    for (let i = 0; i < model.count; i++) {
        const weak = 1 - sigmoid(model.logit[i]);
        const s = amount * weak * weak;
        for (let k = 0; k < 3; k++) {
            const size = Math.exp(model.logScale[i * 3 + k]);
            model.pos[i * 3 + k] += (random() * 2 - 1) * s * size;
        }
    }
    model.touch();
}
