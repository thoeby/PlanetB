// A small deterministic scene, for the trainer's tests. Imported by the node
// tests and served to the browser by client/test/e2e/gsgpu.spec.js, so both
// backends are given exactly the same gaussians and the same cameras.

import { cameraFrom } from '../lib/gsmath.js';
import { Model } from '../lib/gsmodel.js';
import { render, toRgba } from '../lib/gsrast.js';
import { emptySplats } from '../lib/ply.js';

export function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

const norm = (v) => {
    const n = Math.hypot(...v) || 1;
    return v.map((c) => c / n);
};

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]];

// A camera on a ring at 4 m, looking at the middle, with the intrinsics
// client/lib/cameras.js writes into transforms.json.
export function ringCamera(angle, size) {
    const pos = [Math.cos(angle) * 4, 2.2, Math.sin(angle) * 4];
    const back = norm(pos);
    const right = norm(cross([0, 1, 0], back));
    const up = cross(back, right);
    const m = [0, 1, 2].map((k) => [right[k], up[k], back[k], pos[k]]).concat([[0, 0, 0, 1]]);
    return cameraFrom(m, { fl_x: 34, fl_y: 34, cx: size / 2, cy: size / 2, w: size, h: size });
}

export function blobs(n, random, spread = 1.2) {
    const f = emptySplats(n);
    for (let i = 0; i < n; i++) {
        f.x[i] = (random() - 0.5) * 2 * spread;
        f.y[i] = (random() - 0.5) * 2 * spread;
        f.z[i] = (random() - 0.5) * 2 * spread;
        f.sx[i] = 0.14 + random() * 0.2;
        f.sy[i] = 0.14 + random() * 0.2;
        f.sz[i] = 0.14 + random() * 0.2;
        const q = [random() - 0.5, random() - 0.5, random() - 0.5, random() - 0.5];
        const qn = Math.hypot(...q) || 1;
        [f.qw[i], f.qx[i], f.qy[i], f.qz[i]] = q.map((v) => v / qn);
        f.r[i] = random(); f.g[i] = random(); f.b[i] = random();
        f.a[i] = 0.4 + random() * 0.5;
    }
    return Model.fromSplats(f);
}

// What a frame atom would have stored: eight-bit RGB from each pose.
export function viewsOf(model, angles, size) {
    return angles.map((a) => {
        const cam = ringCamera(a, size);
        const rgba = toRgba(render(cam, model.scene()));
        const rgb = new Uint8ClampedArray(size * size * 3);
        for (let i = 0; i < size * size; i++) {
            for (let c = 0; c < 3; c++) rgb[i * 3 + c] = rgba[i * 4 + c];
        }
        return { cam, rgb };
    });
}
