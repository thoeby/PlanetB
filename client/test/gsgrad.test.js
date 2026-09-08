// The trainer's gradients, against finite differences.
//
// client/lib/gsgrad.js is the only part of the trainer whose mistakes are
// silent: a sign error still trains, just to a worse tile. Every stage of the
// chain is checked here on a small scene, with a plain squared-error loss so
// the comparison is not fighting the kink in L1.

import test from 'node:test';
import assert from 'node:assert/strict';

import { cameraFrom } from '../lib/gsmath.js';
import { backwardImage, backwardProject } from '../lib/gsgrad.js';
import { Model, chainColor, zeros } from '../lib/gsmodel.js';
import { render } from '../lib/gsrast.js';
import { emptySplats } from '../lib/ply.js';

const SIZE = 48;

function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

// A camera 6 m out, looking at the middle, with the intrinsics transforms.json
// carries.
function camera() {
    const pos = [3.5, 2.5, 4.5];
    const back = pos.map((v) => v / Math.hypot(...pos));
    const right = [back[2], 0, -back[0]];
    const rn = Math.hypot(...right);
    const r = right.map((v) => v / rn);
    const up = [back[1] * r[2] - back[2] * r[1], back[2] * r[0] - back[0] * r[2],
        back[0] * r[1] - back[1] * r[0]];
    const m = [0, 1, 2].map((k) => [r[k], up[k], back[k], pos[k]]).concat([[0, 0, 0, 1]]);
    return cameraFrom(m, { fl_x: 40, fl_y: 40, cx: SIZE / 2, cy: SIZE / 2, w: SIZE, h: SIZE });
}

function scene(n, random) {
    const f = emptySplats(n);
    for (let i = 0; i < n; i++) {
        f.x[i] = (random() - 0.5) * 2;
        f.y[i] = (random() - 0.5) * 2;
        f.z[i] = (random() - 0.5) * 2;
        f.sx[i] = 0.12 + random() * 0.2;
        f.sy[i] = 0.12 + random() * 0.2;
        f.sz[i] = 0.12 + random() * 0.2;
        const q = [random() - 0.5, random() - 0.5, random() - 0.5, random() - 0.5];
        const qn = Math.hypot(...q);
        [f.qw[i], f.qx[i], f.qy[i], f.qz[i]] = q.map((v) => v / qn);
        f.r[i] = random(); f.g[i] = random(); f.b[i] = random();
        f.a[i] = 0.15 + random() * 0.5;
    }
    return Model.fromSplats(f);
}

const target = (random) => Float32Array.from({ length: SIZE * SIZE * 3 }, () => random());

// Plain squared error, so the finite difference is comparing a smooth function.
function lossOf(model, cam, want) {
    const { rgb } = render(cam, model.scene());
    let sum = 0;
    for (let i = 0; i < rgb.length; i++) sum += (rgb[i] - want[i]) ** 2;
    return sum / rgb.length;
}

function gradOf(model, cam, want) {
    const s = model.scene();
    const image = render(cam, s);
    const d = new Float32Array(image.rgb.length);
    for (let i = 0; i < d.length; i++) {
        d[i] = 2 * (image.rgb[i] - want[i]) / d.length;
    }
    const g = backwardImage(s, image, d);
    const out = chainColor(g, s, zeros(model.count));
    return backwardProject(cam, s, image.pre, g, out);
}

// Central differences on one parameter, with the model rebuilt around it.
function numeric(model, cam, want, field, at, h) {
    const before = model[field][at];
    model[field][at] = before + h; model.touch();
    const up = lossOf(model, cam, want);
    model[field][at] = before - h; model.touch();
    const down = lossOf(model, cam, want);
    model[field][at] = before; model.touch();
    return (up - down) / (2 * h);
}

const STEPS = { pos: 4e-5, logScale: 4e-5, quat: 4e-5, sh: 4e-4, logit: 4e-4 };

// A tiled rasteriser is not a continuous function of its inputs: a splat's
// radius is a whole number of pixels, its tile rectangle a whole number of
// tiles, and a contribution under 1/255 is dropped. Around one of those steps
// the difference quotient measures the step, not the derivative, and says so by
// disagreeing with itself at two step sizes. Those parameters are skipped and
// counted; the rest have to match.
function stable(model, cam, want, field, at) {
    const h = STEPS[field];
    const coarse = numeric(model, cam, want, field, at, h);
    const fine = numeric(model, cam, want, field, at, h / 4);
    return { fine, jumped: Math.abs(coarse - fine) };
}

test('every stage of the backward pass matches a finite difference', () => {
    const random = rng(7);
    const cam = camera();
    const model = scene(24, random);
    const want = target(rng(11));
    const g = gradOf(model, cam, want);
    const bad = [];
    let checked = 0;
    let skipped = 0;
    for (const field of ['pos', 'logScale', 'quat', 'sh', 'logit']) {
        const big = model[field].reduce((m, _v, i) => Math.max(m, Math.abs(g[field][i])), 0);
        const tol = Math.max(big * 0.02, 1e-12);
        const worst = { off: 0, at: -1 };
        for (let at = 0; at < model[field].length; at++) {
            const { fine, jumped } = stable(model, cam, want, field, at);
            if (jumped > tol) { skipped += 1; continue; }
            const off = Math.abs(fine - g[field][at]);
            if (off > worst.off) { worst.off = off; worst.at = at; }
            checked += 1;
        }
        if (worst.off > tol) {
            bad.push(`${field}[${worst.at}] is off by ${(worst.off / tol).toFixed(1)}x`);
        }
    }
    assert.deepEqual(bad, []);
    assert.ok(checked > 200, `only ${checked} parameters were exercised`);
    assert.ok(skipped < checked / 4, `${skipped} of ${checked + skipped} sat on a step`);
});
