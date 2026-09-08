// gsrast.js — the gaussians, rasterised. Plain JS, no GPU.
//
// This is the reference implementation of the tile renderer: front-to-back
// alpha compositing over 16x16 tiles, each tile holding the splats that touch
// it in depth order. `verify` renders two poses with it, and it is what the
// WebGPU trainer (client/lib/gsgpu.js) is checked against, so the shader and
// this file have to say the same thing.
//
// A scene is plain typed arrays, not a ply: positions, linear scales, unit
// quaternions, linear colours and opacities. client/lib/gstrain.js converts.

import { SKY, project } from './gsmath.js';

export const TILE = 16;

// Everything a camera makes of one splat, for every splat: where it lands, how
// wide, and the conic that shapes it. `vis` is 0 for the ones it cannot see.
export function preprocess(cam, scene) {
    const n = scene.count;
    const out = {
        vis: new Uint8Array(n), u: new Float32Array(n), v: new Float32Array(n),
        depth: new Float32Array(n), radius: new Float32Array(n),
        conic: new Float32Array(n * 3), cov: new Float32Array(n * 3),
        tmat: new Float32Array(n * 6), cam: new Float32Array(n * 3),
    };
    for (let i = 0; i < n; i++) {
        const s3 = scene.cov3(i);
        const p = project(cam, [scene.pos[i * 3], scene.pos[i * 3 + 1], scene.pos[i * 3 + 2]], s3);
        if (!p) continue;
        out.vis[i] = 1;
        out.u[i] = p.u; out.v[i] = p.v; out.depth[i] = p.depth; out.radius[i] = p.radius;
        out.conic.set(p.conic, i * 3);
        out.cov.set(p.cov, i * 3);
        out.tmat.set(p.t, i * 6);
        out.cam[i * 3] = p.p.x; out.cam[i * 3 + 1] = p.p.y; out.cam[i * 3 + 2] = p.p.z;
    }
    return out;
}

const tilesAcross = (cam) => ({
    tx: Math.ceil(cam.width / TILE), ty: Math.ceil(cam.height / TILE),
});

// The tiles a splat's bounding square covers, clamped to the image.
function rectOf(cam, pre, i, grid) {
    const r = pre.radius[i];
    return {
        x0: Math.max(0, Math.floor((pre.u[i] - r) / TILE)),
        x1: Math.min(grid.tx - 1, Math.floor((pre.u[i] + r) / TILE)),
        y0: Math.max(0, Math.floor((pre.v[i] - r) / TILE)),
        y1: Math.min(grid.ty - 1, Math.floor((pre.v[i] + r) / TILE)),
    };
}

// One list per tile, each in depth order. Two passes so the lists are packed:
// count, then fill. Sorting is per tile, which is all the compositing needs.
export function tileLists(cam, pre) {
    const grid = tilesAcross(cam);
    const tiles = grid.tx * grid.ty;
    const starts = new Int32Array(tiles + 1);
    for (let i = 0; i < pre.vis.length; i++) {
        if (!pre.vis[i]) continue;
        const r = rectOf(cam, pre, i, grid);
        for (let ty = r.y0; ty <= r.y1; ty++) {
            for (let tx = r.x0; tx <= r.x1; tx++) starts[ty * grid.tx + tx + 1] += 1;
        }
    }
    for (let t = 0; t < tiles; t++) starts[t + 1] += starts[t];
    const items = new Int32Array(starts[tiles]);
    const at = starts.slice(0, tiles);
    for (let i = 0; i < pre.vis.length; i++) {
        if (!pre.vis[i]) continue;
        const r = rectOf(cam, pre, i, grid);
        for (let ty = r.y0; ty <= r.y1; ty++) {
            for (let tx = r.x0; tx <= r.x1; tx++) items[at[ty * grid.tx + tx]++] = i;
        }
    }
    for (let t = 0; t < tiles; t++) {
        const slice = Array.from(items.subarray(starts[t], starts[t + 1]))
            .sort((a, b) => pre.depth[a] - pre.depth[b] || a - b);
        items.set(slice, starts[t]);
    }
    return { starts, items, ...grid };
}

const MIN_ALPHA = 1 / 255;
const MAX_ALPHA = 0.99;
const STOP = 1e-4;

// exp(power) for a pixel, or 0 outside the cutoff.
export function weight(pre, i, dx, dy) {
    const c = pre.conic;
    const power = -0.5 * (c[i * 3] * dx * dx + c[i * 3 + 2] * dy * dy)
        - c[i * 3 + 1] * dx * dy;
    return power > 0 ? 0 : Math.exp(power);
}

// Front to back, one pixel. Returns the colour and what the pixel needs for the
// backward pass: the transmittance left over and how many splats contributed.
function shade(scene, pre, lists, tile, px, py, rgb, at) {
    let t = 1;
    let contributed = 0;
    const [r, g, b] = [0, 1, 2];
    const acc = [0, 0, 0];
    for (let k = lists.starts[tile]; k < lists.starts[tile + 1]; k++) {
        const i = lists.items[k];
        const w = weight(pre, i, px - pre.u[i], py - pre.v[i]);
        if (w === 0) continue;
        const alpha = Math.min(MAX_ALPHA, scene.opacity[i] * w);
        if (alpha < MIN_ALPHA) continue;
        if (t * (1 - alpha) < STOP) break;
        acc[r] += scene.color[i * 3] * alpha * t;
        acc[g] += scene.color[i * 3 + 1] * alpha * t;
        acc[b] += scene.color[i * 3 + 2] * alpha * t;
        t *= 1 - alpha;
        contributed = k + 1 - lists.starts[tile];
    }
    for (let c = 0; c < 3; c++) rgb[at * 3 + c] = acc[c] + SKY[c] * t;
    return { t, contributed };
}

// The image, and the per-pixel state the backward pass reads back.
export function render(cam, scene, pre = preprocess(cam, scene), lists = tileLists(cam, pre)) {
    const { width: w, height: h } = cam;
    const rgb = new Float32Array(w * h * 3);
    const rest = new Float32Array(w * h);
    const last = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const tile = Math.floor(y / TILE) * lists.tx + Math.floor(x / TILE);
            const at = y * w + x;
            const s = shade(scene, pre, lists, tile, x + 0.5, y + 0.5, rgb, at);
            rest[at] = s.t;
            last[at] = s.contributed;
        }
    }
    return { rgb, rest, last, pre, lists, width: w, height: h };
}

// 8-bit RGBA, which is what a frame is stored as and what psnr() compares.
export function toRgba(image) {
    const out = new Uint8ClampedArray(image.width * image.height * 4);
    for (let i = 0; i < image.width * image.height; i++) {
        for (let c = 0; c < 3; c++) {
            out[i * 4 + c] = Math.round(Math.min(1, Math.max(0, image.rgb[i * 3 + c])) * 255);
        }
        out[i * 4 + 3] = 255;
    }
    return out;
}

// The same, from the three-channel bytes a frame is stored as, so a render and
// its reference are compared in one shape (client/lib/render.js's psnr()).
export function toRgbaBytes(rgb) {
    const out = new Uint8ClampedArray(rgb.length / 3 * 4);
    for (let i = 0; i < rgb.length / 3; i++) {
        for (let c = 0; c < 3; c++) out[i * 4 + c] = rgb[i * 3 + c];
        out[i * 4 + 3] = 255;
    }
    return out;
}
