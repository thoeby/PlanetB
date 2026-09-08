// gsgrad.js — the derivative of client/lib/gsrast.js.
//
// Two stages, in the order the chain rule takes them:
//
//   1. compositing: the rendered pixels back to each splat's screen-space
//      quantities — where it landed (u, v), the conic that shaped it, its
//      colour and its opacity.
//   2. projection: those back to the splat's own parameters — position, scale,
//      rotation, spherical-harmonic colour and opacity logit.
//
// Both are checked against finite differences in client/test/gsgrad.test.js,
// which is the only thing that can tell a sign error from a working trainer.

import { SKY } from './gsmath.js';
import { TILE, weight } from './gsrast.js';

const MIN_ALPHA = 1 / 255;
const MAX_ALPHA = 0.99;

export function emptyScreenGrad(n) {
    return { u: new Float32Array(n), v: new Float32Array(n), conic: new Float32Array(n * 3),
        color: new Float32Array(n * 3), opacity: new Float32Array(n), hits: new Int32Array(n) };
}

// One pixel, back to front over the splats that reached it. `acc` is the colour
// accumulated behind the current splat, which is what its alpha trades against.
function unshade(scene, image, g, tile, px, py, at, dL) {
    const { pre, lists } = image;
    const start = lists.starts[tile];
    const bg = SKY[0] * dL[0] + SKY[1] * dL[1] + SKY[2] * dL[2];
    const acc = [0, 0, 0];
    let t = image.rest[at];
    let lastAlpha = 0;
    const lastColor = [0, 0, 0];
    for (let k = start + image.last[at] - 1; k >= start; k--) {
        const i = lists.items[k];
        const dx = px - pre.u[i];
        const dy = py - pre.v[i];
        const w = weight(pre, i, dx, dy);
        if (w === 0) continue;
        const alpha = Math.min(MAX_ALPHA, scene.opacity[i] * w);
        if (alpha < MIN_ALPHA) continue;
        t /= 1 - alpha;
        let dAlpha = 0;
        for (let c = 0; c < 3; c++) {
            const col = scene.color[i * 3 + c];
            acc[c] = lastAlpha * lastColor[c] + (1 - lastAlpha) * acc[c];
            lastColor[c] = col;
            g.color[i * 3 + c] += alpha * t * dL[c];
            dAlpha += (col - acc[c]) * dL[c];
        }
        dAlpha = dAlpha * t - image.rest[at] / (1 - alpha) * bg;
        lastAlpha = alpha;
        splatGrad(g, i, pre, dx, dy, w, scene.opacity[i], dAlpha);
    }
}

// alpha = opacity * exp(power); power is the conic's quadratic form.
function splatGrad(g, i, pre, dx, dy, w, opacity, dAlpha) {
    const c = pre.conic;
    const [a, b, cc] = [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]];
    const dG = opacity * dAlpha;
    g.opacity[i] += w * dAlpha;
    g.u[i] += dG * w * (a * dx + b * dy);
    g.v[i] += dG * w * (b * dx + cc * dy);
    g.conic[i * 3] += dG * w * -0.5 * dx * dx;
    g.conic[i * 3 + 1] += dG * w * -dx * dy;
    g.conic[i * 3 + 2] += dG * w * -0.5 * dy * dy;
    g.hits[i] += 1;
}

// dL/d(rendered pixel) for every pixel, back to the screen-space quantities.
export function backwardImage(scene, image, dLdRgb) {
    const g = emptyScreenGrad(scene.count);
    const w = image.width;
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < w; x++) {
            const at = y * w + x;
            if (!image.last[at]) continue;
            const tile = Math.floor(y / TILE) * image.lists.tx + Math.floor(x / TILE);
            unshade(scene, image, g, tile, x + 0.5, y + 0.5, at,
                [dLdRgb[at * 3], dLdRgb[at * 3 + 1], dLdRgb[at * 3 + 2]]);
        }
    }
    return g;
}

// ------------------------------------------------------------- projection

// conic = inverse of the 2D covariance; this is the derivative of that inverse.
function conicToCov(cov, gc) {
    const [a, b, c] = cov;
    const det = a * c - b * b;
    const inv2 = 1 / (det * det);
    return [
        inv2 * (-c * c * gc[0] + b * c * gc[1] - b * b * gc[2]),
        inv2 * (2 * b * c * gc[0] - (det + 2 * b * b) * gc[1] + 2 * a * b * gc[2]),
        inv2 * (-b * b * gc[0] + a * b * gc[1] - a * a * gc[2]),
    ];
}

// Sigma2 = T Sigma3 T^T. Back to the 3D covariance (full 3x3) and to T.
function covToWorld(t, s3, gcov) {
    const [ga, gb, gc] = gcov;
    const sig = [s3[0], s3[1], s3[2], s3[1], s3[3], s3[4], s3[2], s3[4], s3[5]];
    const st = [0, 0, 0, 0, 0, 0];       // Sigma3 * T^T, 3x2 stored row-major
    for (let m = 0; m < 3; m++) {
        for (let r = 0; r < 2; r++) {
            st[m * 2 + r] = sig[m * 3] * t[r * 3] + sig[m * 3 + 1] * t[r * 3 + 1]
                + sig[m * 3 + 2] * t[r * 3 + 2];
        }
    }
    const g3 = new Float32Array(9);
    for (let m = 0; m < 3; m++) {
        for (let n = 0; n < 3; n++) {
            g3[m * 3 + n] = ga * t[m] * t[n] + gb * t[m] * t[3 + n] + gc * t[3 + m] * t[3 + n];
        }
    }
    const gt = new Float32Array(6);
    for (let c = 0; c < 3; c++) {
        gt[c] = 2 * ga * st[c * 2] + gb * st[c * 2 + 1];
        gt[3 + c] = 2 * gc * st[c * 2 + 1] + gb * st[c * 2];
    }
    return { g3, gt };
}

// T = J W, and J is the derivative of the pixel of a camera-space point, so a
// change in the mean moves the ellipse and reshapes it.
function jacToPoint(cam, p, gt, gu, gv) {
    const d = -p[2];
    const gj = new Float32Array(6);
    for (let r = 0; r < 2; r++) {
        for (let k = 0; k < 3; k++) {
            gj[r * 3 + k] = gt[r * 3] * cam.w[k * 3] + gt[r * 3 + 1] * cam.w[k * 3 + 1]
                + gt[r * 3 + 2] * cam.w[k * 3 + 2];
        }
    }
    const [fx, fy] = [cam.fx, cam.fy];
    return [
        gj[2] * fx / (d * d) + gu * fx / d,
        gj[5] * -fy / (d * d) + gv * -fy / d,
        gj[0] * fx / (d * d) + gj[2] * 2 * fx * p[0] / (d ** 3)
        + gj[4] * -fy / (d * d) + gj[5] * -2 * fy * p[1] / (d ** 3)
        + gu * fx * p[0] / (d * d) + gv * -fy * p[1] / (d * d),
    ];
}

// Sigma3 = M M^T with M = R S: back to the scales and the raw quaternion.
function covToShape(g3, s, q) {
    const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    const [w, x, y, z] = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
    const r = rotOf(w, x, y, z);
    const m = r.map((v, k) => v * s[k % 3]);
    const sym = (i, j) => g3[i * 3 + j] + g3[j * 3 + i];
    const gm = new Float32Array(9);
    for (let k = 0; k < 3; k++) {
        for (let c = 0; c < 3; c++) {
            gm[k * 3 + c] = sym(k, 0) * m[c] + sym(k, 1) * m[3 + c] + sym(k, 2) * m[6 + c];
        }
    }
    const gs = [0, 0, 0];
    const gr = new Float32Array(9);
    for (let c = 0; c < 3; c++) {
        for (let k = 0; k < 3; k++) {
            gs[c] += gm[k * 3 + c] * r[k * 3 + c];
            gr[k * 3 + c] = gm[k * 3 + c] * s[c];
        }
    }
    return { gs, gq: quatGrad([w, x, y, z], gr, n) };
}

export function rotOf(w, x, y, z) {
    return [
        1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ];
}

// dR/dq for each component, then undo the normalisation.
function quatGrad([w, x, y, z], gr, norm) {
    const d = [
        [0, -2 * z, 2 * y, 2 * z, 0, -2 * x, -2 * y, 2 * x, 0],
        [0, 2 * y, 2 * z, 2 * y, -4 * x, -2 * w, 2 * z, 2 * w, -4 * x],
        [-4 * y, 2 * x, 2 * w, 2 * x, 0, 2 * z, -2 * w, 2 * z, -4 * y],
        [-4 * z, -2 * w, 2 * x, 2 * w, -4 * z, 2 * y, 2 * x, 2 * y, 0],
    ];
    const g = d.map((dq) => dq.reduce((sum, v, k) => sum + v * gr[k], 0));
    const dot = g[0] * w + g[1] * x + g[2] * y + g[3] * z;
    const q = [w, x, y, z];
    return g.map((v, k) => (v - q[k] * dot) / norm);
}

// The whole projection stage, splat by splat: screen-space gradients in,
// parameter gradients out.
export function backwardProject(cam, scene, pre, g, out) {
    for (let i = 0; i < scene.count; i++) {
        if (!pre.vis[i] || !g.hits[i]) continue;
        const s3 = scene.cov3(i);
        const gcov = conicToCov(pre.cov.subarray(i * 3, i * 3 + 3),
            g.conic.subarray(i * 3, i * 3 + 3));
        const { g3, gt } = covToWorld(pre.tmat.subarray(i * 6, i * 6 + 6), s3, gcov);
        const gp = jacToPoint(cam, pre.cam.subarray(i * 3, i * 3 + 3), gt, g.u[i], g.v[i]);
        for (let k = 0; k < 3; k++) {
            out.pos[i * 3 + k] += cam.w[k] * gp[0] + cam.w[3 + k] * gp[1] + cam.w[6 + k] * gp[2];
        }
        const s = scene.scale.subarray(i * 3, i * 3 + 3);
        const { gs, gq } = covToShape(g3, s, scene.quat.subarray(i * 4, i * 4 + 4));
        for (let k = 0; k < 3; k++) out.logScale[i * 3 + k] += gs[k] * s[k];
        for (let k = 0; k < 4; k++) out.quat[i * 4 + k] += gq[k];
    }
    return out;
}
