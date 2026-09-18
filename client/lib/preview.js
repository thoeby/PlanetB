// preview.js — a picture of some splats, cheaply, for the work panel.
//
// An atom that runs for minutes says what it is doing with a picture, not a
// counter: the frames as they are traced, the tile as it trains, the sample
// as it lands. This draws splats as points — one pixel each, nearest in
// front — through a pose from client/lib/cameras.js or straight down. It is
// a preview, not a render, and it is meant to be drawn every few seconds
// over a hundred thousand points on the CPU without anybody noticing.

import { permute } from './ply.js';
import { perspective, viewMatrix } from './cameras.js';

const put = (img, depth, size, px, py, d, r, g, b) => {
    if (px < 0 || py < 0 || px >= size || py >= size) return;
    const at = py * size + px;
    if (depth[at] <= d) return;
    depth[at] = d;
    img[at * 4] = r; img[at * 4 + 1] = g; img[at * 4 + 2] = b; img[at * 4 + 3] = 255;
};

const blank = (size) => ({
    rgba: new Uint8ClampedArray(size * size * 4).fill(0),
    depth: new Float32Array(size * size).fill(Infinity),
});

// Through a camera: `cam` is {position, target, up, fov} as cameras.js makes
// them. Points behind the eye are skipped.
export function pointsPicture(f, cam, size = 256, { near = 0.5, far = 20000 } = {}) {
    const { rgba, depth } = blank(size);
    const v = viewMatrix(cam);
    const p = perspective(cam.fov, 1, near, far);
    for (let i = 0; i < f.count; i++) {
        const x = f.x[i]; const y = f.y[i]; const z = f.z[i];
        const cx = v[0] * x + v[4] * y + v[8] * z + v[12];
        const cy = v[1] * x + v[5] * y + v[9] * z + v[13];
        const cz = v[2] * x + v[6] * y + v[10] * z + v[14];
        if (cz > -near) continue;
        const w = -cz;
        const sx = (p[0] * cx / w + 1) * 0.5 * size;
        const sy = (1 - p[5] * cy / w) * 0.5 * size;
        put(rgba, depth, size, sx | 0, sy | 0, w,
            f.r[i] * 255, f.g[i] * 255, f.b[i] * 255);
    }
    return { rgba, width: size, height: size };
}

// Straight down, north up, the whole extent of the splats filling the square.
export function topDown(f, size = 256) {
    const { rgba, depth } = blank(size);
    let lo = [Infinity, Infinity]; let hi = [-Infinity, -Infinity];
    for (let i = 0; i < f.count; i++) {
        lo = [Math.min(lo[0], f.x[i]), Math.min(lo[1], f.z[i])];
        hi = [Math.max(hi[0], f.x[i]), Math.max(hi[1], f.z[i])];
    }
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]) || 1;
    for (let i = 0; i < f.count; i++) {
        const px = ((f.x[i] - lo[0]) / span * (size - 1)) | 0;
        const py = ((f.z[i] - lo[1]) / span * (size - 1)) | 0;
        // Higher is nearer to a camera looking down.
        put(rgba, depth, size, px, py, -f.y[i], f.r[i] * 255, f.g[i] * 255, f.b[i] * 255);
    }
    return { rgba, width: size, height: size };
}

// Every splat's fields in a fixed random order, so any prefix of the list is
// a fair sample of the whole: a preview reads the first hundred thousand.
export function shuffled(f, random) {
    const n = f.count;
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    return permute(f, order);
}
