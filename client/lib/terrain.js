// terrain.js — the ground of a tile: the seeded DEM, then what the world says
// about it (terrainmods, road cuts), then a mesh and the height.r16 the player
// walks on.
//
// The grid is laid over the rectangle the tile's south-west and north-east
// corners span in its own frame, north-west first, exactly as
// client/js/player.js reads it back.

import { sampleHeight } from './geo.js';
import { SUN, shade } from './light.js';
import { Mesh } from './mesh.js';
import { styleFor } from './rules.js';

// Vertices across a tile. The store cuts elevation at 256² a tile
// (server/splatworld/importer.py DEM_SIZE), so 257 reads all of it: 0.4 m at
// z18, 1.6 m at z16, 6 m at z14. 129 threw three quarters of a 0.5 m survey
// away before anything was drawn.
export const GRID = { 18: 257, 16: 257, 14: 257, 12: 97, 10: 65, 8: 49, 6: 33 };

// Bilinear height over a row-major grid, in metres, for anything that has to
// stand on the ground. `null` outside the grid, where nothing is known.
export function heightOn(h, size, west, north, stepX, stepZ, x, z) {
    const fu = (x - west) / stepX;
    const fv = (z - north) / stepZ;
    if (fu < 0 || fv < 0 || fu > size - 1 || fv > size - 1) return null;
    const i = Math.min(Math.floor(fu), size - 2);
    const j = Math.min(Math.floor(fv), size - 2);
    const su = fu - i;
    const sv = fv - j;
    const a = h[j * size + i];
    const b = h[j * size + i + 1];
    const c = h[(j + 1) * size + i];
    const d = h[(j + 1) * size + i + 1];
    return (a * (1 - su) + b * su) * (1 - sv) + (c * (1 - su) + d * su) * sv;
}

// How far above the sun's ray the ground may rise before the ray is stopped
// entirely: a shadow's edge is a ramp this wide rather than a stair. At least
// a cell, so the ramp is never narrower than the grid can draw.
const SHADOW_SOFT_M = 1.5;
// How far towards the sun the ground is asked. A ridge further off than this
// throws no shadow here, which at the sun's height is a ridge six hundred
// metres higher than where you stand.
export const SHADOW_REACH_M = 400;

// Whether the sun reaches (x, y, z): the ground between here and the sun,
// out to SHADOW_REACH_M, marched a cell at a time. 1 in the sun, 0 behind a
// ridge. `hAt(x, z)` answers the ground's height or null past its edge, where
// the march stops and the sun is taken to shine — the same answer the ground
// mesh and the tile give at the same edge, so they agree there too.
export function sunlitAt(hAt, x, y, z, cell) {
    const run = Math.hypot(SUN[0], SUN[2]);
    const dx = SUN[0] / run;
    const dz = SUN[2] / run;
    const rise = SUN[1] / run;
    const soft = Math.max(SHADOW_SOFT_M, cell);
    const step = cell / 2;
    let blocked = 0;
    for (let d = step; d <= SHADOW_REACH_M; d += step) {
        const h = hAt(x + dx * d, z + dz * d);
        if (h === null) break;
        blocked = Math.max(blocked, h - (y + rise * d));
        if (blocked >= soft) break;
    }
    return 1 - clamp01(blocked / soft);
}

export class Terrain {
    constructor({ sw, ne, size, dem }) {
        this.size = size;
        this.west = sw.x;
        this.north = ne.z;
        this.stepX = (ne.x - sw.x) / (size - 1);
        this.stepZ = (sw.z - ne.z) / (size - 1);
        // What `h` is measured from, above sea level: assemble lowers the
        // heights to the tile's own frame and says so here, so the colour
        // bands still know how high the ground really is.
        this.datum = 0;
        this.h = new Float64Array(size * size);
        for (let j = 0; j < size; j++) {
            for (let i = 0; i < size; i++) {
                this.h[j * size + i] = dem
                    ? sampleHeight(dem, i / (size - 1), j / (size - 1)) : 0;
            }
        }
    }

    x(i) { return this.west + i * this.stepX; }
    z(j) { return this.north + j * this.stepZ; }

    // Bilinear, in metres, clamped to the edge, for anything that has to
    // stand on the ground.
    at(x, z) {
        const cx = Math.min(Math.max(x, this.west), this.x(this.size - 1));
        const cz = Math.min(Math.max(z, this.north), this.z(this.size - 1));
        return heightOn(this.h, this.size, this.west, this.north,
            this.stepX, this.stepZ, cx, cz);
    }

    // The same, and null past the edge: what a shadow's march asks.
    within(x, z) {
        return heightOn(this.h, this.size, this.west, this.north, this.stepX, this.stepZ, x, z);
    }

    get cell() { return Math.min(Math.abs(this.stepX), Math.abs(this.stepZ)); }

    // Every grid point within `radius` of (x, z), as flat indices.
    near(x, z, radius) {
        const out = [];
        const i0 = Math.max(0, Math.floor((x - radius - this.west) / this.stepX));
        const i1 = Math.min(this.size - 1, Math.ceil((x + radius - this.west) / this.stepX));
        const j0 = Math.max(0, Math.floor((z - radius - this.north) / this.stepZ));
        const j1 = Math.min(this.size - 1, Math.ceil((z + radius - this.north) / this.stepZ));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out.push(j * this.size + i);
        return out;
    }

    slope(i, j) {
        const n = this.size;
        const l = this.h[j * n + Math.max(i - 1, 0)];
        const r = this.h[j * n + Math.min(i + 1, n - 1)];
        const u = this.h[Math.max(j - 1, 0) * n + i];
        const d = this.h[Math.min(j + 1, n - 1) * n + i];
        return Math.hypot((r - l) / (2 * this.stepX), (d - u) / (2 * this.stepZ));
    }
}

// raise / lower / flatten / smooth, in the order the features are given, which
// is the order the API returns them in: by id (Invariant 2).
export function applyTerrainmods(terrain, mods, rules = []) {
    for (const mod of mods) {
        const style = styleFor(rules, mod);
        const amount = Number(style.amount ?? mod.props?.amount ?? 0);
        const op = String(style.op ?? mod.props?.op ?? 'flatten').toLowerCase();
        const points = mod.rings.flat();
        if (!points.length) continue;
        const level = op === 'flatten'
            ? points.reduce((s, p) => s + terrain.at(p[0], p[1]), 0) / points.length
            : 0;
        for (let j = 0; j < terrain.size; j++) {
            for (let i = 0; i < terrain.size; i++) {
                const k = j * terrain.size + i;
                if (!mod.contains(terrain.x(i), terrain.z(j))) continue;
                if (op === 'raise') terrain.h[k] += amount;
                else if (op === 'lower') terrain.h[k] -= amount;
                else if (op === 'flatten') terrain.h[k] = level + amount;
                else if (op === 'smooth') terrain.h[k] = smoothed(terrain, i, j);
            }
        }
    }
}

const smoothed = (t, i, j) => {
    let sum = 0;
    let n = 0;
    for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= t.size || jj >= t.size) continue;
            sum += t.h[jj * t.size + ii];
            n += 1;
        }
    }
    return sum / n;
};

// A road is cut into the hill: the corridor is pulled towards the height of the
// centreline, with a shoulder that fades back to the natural ground.
export function cutRoads(terrain, roads) {
    for (const road of roads) {
        const half = road.width / 2;
        for (const { a, b, ha, hb } of road.segments) {
            const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
            const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            for (const k of terrain.near(mid[0], mid[1], len / 2 + half * 3)) {
                const i = k % terrain.size;
                const j = (k - i) / terrain.size;
                const { d, t } = distanceToSegment([terrain.x(i), terrain.z(j)], a, b);
                if (d > half * 3) continue;
                const level = ha * (1 - t) + hb * t;
                const w = d <= half ? 1 : 1 - (d - half) / (half * 2);
                terrain.h[k] += (level - terrain.h[k]) * w;
            }
        }
    }
}

export function distanceToSegment(p, a, b) {
    const vx = b[0] - a[0];
    const vz = b[1] - a[1];
    const len2 = vx * vx + vz * vz;
    const t = len2 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / len2)) : 0;
    return { d: Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vz)), t };
}

// What the ground is made of, by height and slope.
//
// There is no orthophoto in this world — there is none to drape (SPEC §7) —
// so the terrain says what it is from where it is and how steep. It is a ramp
// with a stop for each thing a mountainside actually is, and the blends
// between them are the DEM's own height and slope. No noise on top: the
// survey is half a metre, and the relief it holds is the detail; a pattern
// laid over it is a pattern, and reads as one. Steep ground is rock at every
// height, because it is.
const BANDS = [
    { to: 600, colour: [0.34, 0.50, 0.20] },   // the valley floor, lush
    { to: 1400, colour: [0.40, 0.54, 0.22] },  // pasture
    { to: 2100, colour: [0.46, 0.54, 0.25] },  // the alp, going dry
    { to: 2500, colour: [0.56, 0.53, 0.45] },  // scree
    { to: 2900, colour: [0.60, 0.58, 0.55] },  // rock
    { to: Infinity, colour: [0.90, 0.92, 0.95] }, // snow
];

const ROCK = [0.48, 0.45, 0.41];
const mix = (a, b, t) => a.map((c, i) => c * (1 - t) + b[i] * t);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function band(height) {
    for (let i = 0; i < BANDS.length; i++) {
        if (height > BANDS[i].to) continue;
        if (i === 0) return BANDS[0].colour;
        const from = BANDS[i - 1];
        const span = Math.min(BANDS[i].to, from.to + 900) - from.to;
        return mix(from.colour, BANDS[i].colour,
            clamp01((height - from.to) / (span || 1)));
    }
    return BANDS.at(-1).colour;
}

// `openness` is how much sky this point can see, 0..1: a crease in the
// hillside is dirtier than the shoulder above it. The light it loses is
// lightAt()'s to take (client/lib/light.js), so this is mild.
export function terrainColour(slope, height, openness = 1) {
    const rocky = clamp01((slope - 0.35) / 0.7);
    const ground = mix(band(height), ROCK, rocky * 0.85);
    const ao = 0.8 + 0.2 * clamp01(openness);
    return ground.map((c) => c * ao);
}

// How much sky one grid point can see, from the ground around it: every
// neighbour that rises above the horizontal takes a little away. Cheap, and
// entirely the DEM's own answer.
export function openAt(h, size, i, j, stepX, stepZ, radius = 3) {
    const here = h[j * size + i];
    let blocked = 0;
    let n = 0;
    for (let dj = -radius; dj <= radius; dj++) {
        for (let di = -radius; di <= radius; di++) {
            if (!di && !dj) continue;
            const x = Math.min(Math.max(i + di, 0), size - 1);
            const y = Math.min(Math.max(j + dj, 0), size - 1);
            const far = Math.hypot(di * stepX, dj * stepZ) || 1;
            blocked += Math.max(0, (h[y * size + x] - here) / far);
            n += 1;
        }
    }
    return clamp01(1 - (blocked / Math.max(n, 1)) * 1.6);
}

// The ground, lit: assemble-v3 bakes the light into every vertex it writes
// (light.js shade), so the frames, the sampled splats and the ground mesh
// carry one colour and meet without a seam.
export function terrainMesh(terrain, material = 'terrain') {
    const m = new Mesh(material);
    const n = terrain.size;
    const hAt = (x, z) => terrain.within(x, z);
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const h = terrain.h[j * n + i];
            const s = terrain.slope(i, j);
            const open = openAt(terrain.h, n, i, j,
                Math.abs(terrain.stepX), Math.abs(terrain.stepZ));
            const normal = normalAt(terrain, i, j);
            const x = terrain.x(i);
            const z = terrain.z(j);
            const own = terrainColour(s, h + terrain.datum, open);
            m.vertex([x, h, z], normal, shade(own, normal, open,
                sunlitAt(hAt, x, h, z, terrain.cell)));
        }
    }
    for (let j = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
            const a = j * n + i;
            m.tri(a, a + n, a + 1);
            m.tri(a + 1, a + n, a + n + 1);
        }
    }
    return m;
}

function normalAt(t, i, j) {
    const n = t.size;
    const l = t.h[j * n + Math.max(i - 1, 0)];
    const r = t.h[j * n + Math.min(i + 1, n - 1)];
    const u = t.h[Math.max(j - 1, 0) * n + i];
    const d = t.h[Math.min(j + 1, n - 1) * n + i];
    const v = [-(r - l) / (2 * t.stepX), 1, -(d - u) / (2 * t.stepZ)];
    const len = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / len, v[1] / len, v[2] / len];
}

// height.r16: uint16 samples, row-major, north-west first, linear between min
// and max — the format client/js/player.js reads (db/0011_tilefiles.sql).
export function heightRaster(terrain) {
    let min = Infinity;
    let max = -Infinity;
    for (const v of terrain.h) { min = Math.min(min, v); max = Math.max(max, v); }
    const span = max - min || 1;
    const data = new Uint16Array(terrain.h.length);
    for (let i = 0; i < data.length; i++) {
        data[i] = Math.round((terrain.h[i] - min) / span * 65535);
    }
    return { bytes: new Uint8Array(data.buffer), meta: { size: terrain.size, min, max } };
}

// Everything standing on the ground, lit the same way the ground was: its
// own colour under the sky, and in the ground's shadow where the ground
// throws one. Colours are replaced in place; the terrain is already lit.
export function bakeLight(meshes, terrain) {
    const hAt = (x, z) => terrain.within(x, z);
    for (const m of meshes) {
        if (m.material === 'terrain') continue;
        const { positions: p, normals: nn, colors: c } = m;
        for (let i = 0; i < p.length; i += 3) {
            const lit = shade([c[i], c[i + 1], c[i + 2]], [nn[i], nn[i + 1], nn[i + 2]], 1,
                sunlitAt(hAt, p[i], p[i + 1], p[i + 2], terrain.cell));
            c[i] = lit[0]; c[i + 1] = lit[1]; c[i + 2] = lit[2];
        }
    }
    return meshes;
}
