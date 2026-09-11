// terrain.js — the ground of a tile: the seeded DEM, then what the world says
// about it (terrainmods, road cuts), then a mesh and the height.r16 the player
// walks on.
//
// The grid is laid over the rectangle the tile's south-west and north-east
// corners span in its own frame, north-west first, exactly as
// client/js/player.js reads it back.

import { sampleHeight } from './geo.js';
import { Mesh } from './mesh.js';
import { styleFor } from './rules.js';

export const GRID = { 18: 129, 16: 129, 14: 129, 12: 97, 10: 65, 8: 49, 6: 33 };

export class Terrain {
    constructor({ sw, ne, size, dem }) {
        this.size = size;
        this.west = sw.x;
        this.north = ne.z;
        this.stepX = (ne.x - sw.x) / (size - 1);
        this.stepZ = (sw.z - ne.z) / (size - 1);
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

    // Bilinear, in metres, for anything that has to stand on the ground.
    at(x, z) {
        const fu = Math.min(Math.max((x - this.west) / this.stepX, 0), this.size - 1);
        const fv = Math.min(Math.max((z - this.north) / this.stepZ, 0), this.size - 1);
        const i = Math.min(Math.floor(fu), this.size - 2);
        const j = Math.min(Math.floor(fv), this.size - 2);
        const su = fu - i;
        const sv = fv - j;
        const a = this.h[j * this.size + i];
        const b = this.h[j * this.size + i + 1];
        const c = this.h[(j + 1) * this.size + i];
        const d = this.h[(j + 1) * this.size + i + 1];
        return (a * (1 - su) + b * su) * (1 - sv) + (c * (1 - su) + d * su) * sv;
    }

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

// The ground's colour, from the ground itself: grass, turning to rock where it
// is steep and to snow where it is high. No imagery is draped over the world —
// there is none to drape (TASKS-usable: real ground, empty). When ground types
// exist they will decide this; until then the terrain says what it is.
export function terrainColour(slope, height) {
    const base = [0.35, 0.4, 0.3];
    const rock = Math.min(1, Math.max(0, (slope - 0.4) / 0.8)) * 0.7;
    const alp = Math.min(1, Math.max(0, (height - 1800) / 900)) * 0.6;
    const mix = (c, t, to) => c * (1 - t) + to * t;
    return base.map((c, i) => mix(mix(c, rock, [0.42, 0.4, 0.38][i]), alp, 0.9));
}

export function terrainMesh(terrain, material = 'terrain') {
    const m = new Mesh(material);
    const n = terrain.size;
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const h = terrain.h[j * n + i];
            const s = terrain.slope(i, j);
            m.vertex([terrain.x(i), h, terrain.z(j)], normalAt(terrain, i, j),
                terrainColour(s, h));
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
