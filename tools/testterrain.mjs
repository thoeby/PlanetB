// testterrain.mjs — the synthetic ground WP1.2 publishes: a hill described once
// and emitted three ways, so the splats you see, the heightmap you walk on and
// the boxes you bump into all agree.

import * as tm from '../client/lib/tilemath.js';

export const GRID = { 6: 24, 8: 32, 10: 48 };

// mulberry32: the same tiles come out on every machine and every run.
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------- splat blobs

// A grid of gaussians over the tile, in the tile's own frame (X east, Y up,
// Z south, metres). Height and colour come from a few sines plus a couple of
// blobs, so a tile is recognisable when you fly over it and every zoom of the
// same ground looks like the same place.
// The ground of a tile, as a function of its (u, v) in 0..1 and nothing else,
// so the splats, the heightmap and the colliders all describe the same hill.
export function ground(z, x, y) {
    const origin = tm.tileFrame(z, x, y, 0);
    const b = tm.tileBbox(z, x, y);
    const sw = tm.localFromLonLat(origin, b.west, b.south);
    const ne = tm.localFromLonLat(origin, b.east, b.north);
    const relief = Math.max(20, (ne.x - sw.x) * 0.04);
    const r = rng(z * 1000003 + x * 1009 + y);
    const blobs = Array.from({ length: 3 }, () => ({
        u: r(), v: r(), rad: 0.12 + r() * 0.18,
        col: [0.3 + r() * 0.7, 0.3 + r() * 0.7, 0.3 + r() * 0.7],
    }));
    // Phase runs on the tile's own coordinates, so the hill is continuous
    // across tile edges and no two tiles get the same heightmap — identical
    // bytes would be one artifact, and the store refuses to write it twice.
    const height = (u, v) => relief * (Math.sin((x + u) * 6.3) * Math.cos((y + v) * 4.1)
        + 0.4 * Math.sin((x + u) * 17 + (y + v) * 11));
    return { origin, sw, ne, relief, blobs, height };
}

export function makeSplats(z, x, y) {
    const g = GRID[z];
    const n = g * g;
    const { origin, sw, ne, relief, blobs, height } = ground(z, x, y);
    const stepX = (ne.x - sw.x) / (g - 1);
    const stepZ = (sw.z - ne.z) / (g - 1);

    const f = { count: n };
    for (const k of ['x', 'y', 'z', 'r', 'g', 'b', 'a', 'sx', 'sy', 'sz',
        'qx', 'qy', 'qz', 'qw']) f[k] = new Float32Array(n);

    for (let j = 0; j < g; j++) {
        for (let i = 0; i < g; i++) {
            const k = j * g + i;
            const u = i / (g - 1), v = j / (g - 1);
            const h = height(u, v);
            f.x[k] = sw.x + i * stepX;
            f.y[k] = h;
            f.z[k] = sw.z - j * stepZ;
            const t = h / relief * 0.5 + 0.5;
            let col = [0.25 + 0.5 * t, 0.45 + 0.35 * (1 - t), 0.2 + 0.3 * t];
            for (const blob of blobs) {
                const d = Math.hypot(u - blob.u, v - blob.v);
                if (d < blob.rad) col = blob.col;
            }
            [f.r[k], f.g[k], f.b[k]] = col;
            f.a[k] = 1;
            f.sx[k] = stepX * 0.6;
            f.sy[k] = relief * 0.05 + 0.5;
            f.sz[k] = stepZ * 0.6;
            f.qw[k] = 1;
        }
    }
    return { splats: f, origin };
}

const HEIGHT_SIZE = 256;

// height.r16 — uint16 samples, row-major, north-west first, linear between min
// and max. Same ground() as the splats, so the player walks on what they see.
export function makeHeight(z, x, y) {
    const { height } = ground(z, x, y);
    const data = new Uint16Array(HEIGHT_SIZE * HEIGHT_SIZE);
    let min = Infinity, max = -Infinity;
    const h = new Float64Array(data.length);
    for (let v = 0; v < HEIGHT_SIZE; v++) {
        for (let u = 0; u < HEIGHT_SIZE; u++) {
            const e = height(u / (HEIGHT_SIZE - 1), v / (HEIGHT_SIZE - 1));
            h[v * HEIGHT_SIZE + u] = e;
            min = Math.min(min, e);
            max = Math.max(max, e);
        }
    }
    const span = max - min || 1;
    for (let i = 0; i < h.length; i++) {
        data[i] = Math.round((h[i] - min) / span * 65535);
    }
    return { bytes: Buffer.from(data.buffer), meta: { size: HEIGHT_SIZE, min, max } };
}

// A handful of boxes standing on the hill, so WP1.4 has something to slide
// along until WP2.3's assemble produces real ones.
export function makeColliders(z, x, y) {
    const { sw, ne, height } = ground(z, x, y);
    const r = rng(z * 7919 + x * 131 + y * 17);
    const boxes = [];
    for (let i = 0; i < 6; i++) {
        const u = 0.1 + r() * 0.8, v = 0.1 + r() * 0.8;
        const w = 6 + r() * 14, d = 6 + r() * 14, tall = 4 + r() * 16;
        const base = height(u, v);
        boxes.push({
            center: [sw.x + u * (ne.x - sw.x), base + tall / 2, sw.z - v * (sw.z - ne.z)],
            half: [w / 2, tall / 2, d / 2],
            yaw: r() * Math.PI,
        });
    }
    return Buffer.from(`${JSON.stringify({ boxes })}\n`, 'utf8');
}

const PLY_PROPS = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const SH_C0 = 0.28209479177387814;

// The merge atom's real output: the same gaussians as an uncompressed ply, in
// the field order the splat tooling uses. The sog is this, encoded.
export function writePly(f) {
    const n = f.count;
    const head = Buffer.from('ply\nformat binary_little_endian 1.0\n'
        + `element vertex ${n}\n`
        + `${PLY_PROPS.map((p) => `property float ${p}\n`).join('')}`
        + 'end_header\n', 'ascii');
    const body = Buffer.alloc(n * PLY_PROPS.length * 4);
    for (let i = 0; i < n; i++) {
        const v = [f.x[i], f.y[i], f.z[i],
            (f.r[i] - 0.5) / SH_C0, (f.g[i] - 0.5) / SH_C0, (f.b[i] - 0.5) / SH_C0,
            20, Math.log(f.sx[i]), Math.log(f.sy[i]), Math.log(f.sz[i]),
            f.qw[i], f.qx[i], f.qy[i], f.qz[i]];
        for (let k = 0; k < v.length; k++) {
            body.writeFloatLE(v[k], (i * v.length + k) * 4);
        }
    }
    return Buffer.concat([head, body]);
}
