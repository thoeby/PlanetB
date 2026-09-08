// gsmodel.js — the gaussians as something to optimise.
//
// A ply stores what a gaussian is; a trainer needs what it can move. Scales are
// held as logarithms so they stay positive, opacity as a logit so it stays in
// (0, 1), colour as the band-0 spherical-harmonic coefficient the format
// carries, and the rotation as a raw quaternion normalised on use. That is the
// same reparametrisation client/lib/ply.js writes and reads, so a model and a
// ply are the same object in two coordinates.

import { cov3d, logit, sigmoid } from './gsmath.js';
import { SH_C0, emptySplats } from './ply.js';

export const FIELDS = ['pos', 'logScale', 'quat', 'sh', 'logit'];
export const WIDTH = { pos: 3, logScale: 3, quat: 4, sh: 3, logit: 1 };

export function zeros(count) {
    const g = {};
    for (const k of FIELDS) g[k] = new Float32Array(count * WIDTH[k]);
    return g;
}

export class Model {
    constructor(count) {
        this.count = count;
        Object.assign(this, zeros(count));
        this.derived = null;
    }

    static fromSplats(f) {
        const m = new Model(f.count);
        for (let i = 0; i < f.count; i++) {
            m.pos.set([f.x[i], f.y[i], f.z[i]], i * 3);
            m.logScale.set([Math.log(f.sx[i]), Math.log(f.sy[i]), Math.log(f.sz[i])], i * 3);
            m.quat.set([f.qw[i], f.qx[i], f.qy[i], f.qz[i]], i * 4);
            m.sh.set([(f.r[i] - 0.5) / SH_C0, (f.g[i] - 0.5) / SH_C0, (f.b[i] - 0.5) / SH_C0],
                i * 3);
            m.logit[i] = logit(Math.min(Math.max(f.a[i], 1e-6), 1 - 1e-6));
        }
        return m;
    }

    toSplats() {
        const f = emptySplats(this.count);
        const s = this.scene();
        for (let i = 0; i < this.count; i++) {
            [f.x[i], f.y[i], f.z[i]] = this.pos.subarray(i * 3, i * 3 + 3);
            [f.sx[i], f.sy[i], f.sz[i]] = s.scale.subarray(i * 3, i * 3 + 3);
            [f.r[i], f.g[i], f.b[i]] = s.color.subarray(i * 3, i * 3 + 3);
            f.a[i] = s.opacity[i];
            const q = s.quat.subarray(i * 4, i * 4 + 4);
            [f.qw[i], f.qx[i], f.qy[i], f.qz[i]] = q;
        }
        return f;
    }

    // What the rasteriser reads: linear scales, unit quaternions, linear colour
    // and opacity, rebuilt whenever the parameters move.
    scene() {
        if (this.derived) return this.derived;
        const n = this.count;
        const d = { count: n, pos: this.pos, scale: new Float32Array(n * 3),
            quat: new Float32Array(n * 4), color: new Float32Array(n * 3),
            opacity: new Float32Array(n) };
        for (let i = 0; i < n; i++) {
            for (let k = 0; k < 3; k++) {
                d.scale[i * 3 + k] = Math.exp(this.logScale[i * 3 + k]);
                d.color[i * 3 + k] = 0.5 + SH_C0 * this.sh[i * 3 + k];
            }
            const q = this.quat.subarray(i * 4, i * 4 + 4);
            const norm = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
            for (let k = 0; k < 4; k++) d.quat[i * 4 + k] = q[k] / norm;
            d.opacity[i] = sigmoid(this.logit[i]);
        }
        d.cov3 = (i) => cov3d(d.scale.subarray(i * 3, i * 3 + 3),
            d.quat.subarray(i * 4, i * 4 + 4));
        this.derived = d;
        return d;
    }

    touch() { this.derived = null; }

    // Keeps the rows `keep` names, in that order. Densify and prune both go
    // through it so nothing else has to know how a model is laid out.
    select(keep) {
        const out = new Model(keep.length);
        for (const k of FIELDS) {
            const w = WIDTH[k];
            for (let n = 0; n < keep.length; n++) {
                out[k].set(this[k].subarray(keep[n] * w, keep[n] * w + w), n * w);
            }
        }
        return out;
    }
}

// The gradients the rasteriser produces are in scene coordinates; these are the
// two chain rules that put them back in the model's.
export function chainColor(g, scene, out) {
    for (let i = 0; i < scene.count; i++) {
        for (let k = 0; k < 3; k++) out.sh[i * 3 + k] += g.color[i * 3 + k] * SH_C0;
        out.logit[i] += g.opacity[i] * scene.opacity[i] * (1 - scene.opacity[i]);
    }
    return out;
}

// 0.8 * L1 + 0.2 * L2 over every pixel and channel. The paper's second term is
// D-SSIM; this is the same idea — punish the big misses harder than the small
// ones — without a windowed statistic to carry through the shader.
export const L2_SHARE = 0.2;

export function lossGrad(rgb, target) {
    const n = rgb.length;
    const d = new Float32Array(n);
    let loss = 0;
    for (let i = 0; i < n; i++) {
        const e = rgb[i] - target[i];
        loss += (1 - L2_SHARE) * Math.abs(e) + L2_SHARE * e * e;
        d[i] = ((1 - L2_SHARE) * Math.sign(e) + 2 * L2_SHARE * e) / n;
    }
    return { loss: loss / n, dLdRgb: d };
}

// A ply's fields as the rasteriser wants them, without going through a model:
// `verify` renders a published .sog and never optimises it.
export function sceneOf(f) {
    const n = f.count;
    const d = { count: n, pos: new Float32Array(n * 3), scale: new Float32Array(n * 3),
        quat: new Float32Array(n * 4), color: new Float32Array(n * 3), opacity: f.a };
    for (let i = 0; i < n; i++) {
        d.pos.set([f.x[i], f.y[i], f.z[i]], i * 3);
        d.scale.set([f.sx[i], f.sy[i], f.sz[i]], i * 3);
        d.color.set([f.r[i], f.g[i], f.b[i]], i * 3);
        const q = [f.qw[i], f.qx[i], f.qy[i], f.qz[i]];
        const norm = Math.hypot(...q) || 1;
        d.quat.set(q.map((v) => v / norm), i * 4);
    }
    d.cov3 = (i) => cov3d(d.scale.subarray(i * 3, i * 3 + 3),
        d.quat.subarray(i * 4, i * 4 + 4));
    return d;
}
