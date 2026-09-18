// sculpt.js — shaping a land's ground, in the page.
//
// FND.9. What a stroke changes is one land's grid of relative metres
// (client/lib/r32.js); the DEM underneath is never touched, so the operator can
// replace it with a better one and what somebody shaped is still what they
// shaped.
//
// Pure except for the fetch that loads the land's current file and the PUT
// that saves the next one. Nothing here decides who may shape a land: the row
// the save writes is authorised by row-level security (Invariant 6), and the
// compiler ignores every cell outside the land whatever got written
// (client/lib/terrain.js).

import * as api from './api.js';
import { CELLS_PER_TILE, gridFor, readR32, sampleR32, writeR32 } from '../lib/r32.js';
import { sha256 } from '../lib/hash.js';
import { contains } from '../lib/poly.js';
import { tileBbox, tileX, tileY } from '../lib/tilemath.js';

export const BRUSHES = [
    { id: 'raise', words: 'Raise', key: 'r' },
    { id: 'lower', words: 'Lower', key: 'f' },
    { id: 'smooth', words: 'Smooth', key: 's' },
    { id: 'flatten', words: 'Flatten', key: 'g' },
    { id: 'level', words: 'Level', key: 'l' },
    { id: 'line', words: 'Along line', key: 'b' },
];

export const brushWords = (id) => BRUSHES.find((b) => b.id === id)?.words ?? id;

// The finest the world is ever compiled at: 512 cells across a z18 tile
// (client/lib/r32.js). Read off the tile the land's middle falls in, so a land
// near the pole and one at the equator are both shaped at the same metres.
export function cellFor(bbox) {
    const lat = (bbox.south + bbox.north) / 2;
    const lon = (bbox.west + bbox.east) / 2;
    const t = tileBbox(18, tileX(lon, 18), tileY(lat, 18));
    const metres = (t.east - t.west) * 111320 * Math.cos(lat * Math.PI / 180);
    return Math.max(0.05, metres / CELLS_PER_TILE);
}

const box = (bbox) => [bbox.west, bbox.south, bbox.east, bbox.north];

export class Shaping {
    constructor(area, grid, rev = 0) {
        this.area = area;
        this.grid = grid;
        this.rev = rev;
        this.rings = ringsOf(area.outline);
        this.strokes = [];
        this.undone = [];
        this.touched = null;
        this.stroke = null;
    }

    // What the land is shaped into right now, as the world holds it.
    static async load(area) {
        const grid = gridFor(box(area.bbox), cellFor(area.bbox));
        const [row] = await api.select('height_edit', {
            area_id: `eq.${area.id}`, order: 'rev.desc', limit: '1',
            select: 'sha256,rev',
        }).catch(() => []);
        if (!row) return new Shaping(area, grid);
        const res = await fetch(`${api.endpoints().files}/assets/${row.sha256}.r32`)
            .catch(() => null);
        if (!res?.ok) return new Shaping(area, grid, Number(row.rev));
        const got = readR32(new Uint8Array(await res.arrayBuffer()));
        return new Shaping(area, got.width === grid.width && got.height === grid.height
            ? got : grid, Number(row.rev));
    }

    get dirty() { return this.strokes.length > 0; }

    inside(lon, lat) { return contains(this.rings, lon, lat); }

    at(lon, lat) { return sampleR32(this.grid, lon, lat); }

    // Where a cell is, in degrees.
    lonOf(i) {
        const [w, , e] = this.grid.bbox;
        return w + (e - w) * i / (this.grid.width - 1);
    }

    latOf(j) {
        const [, s, , n] = this.grid.bbox;
        return n - (n - s) * j / (this.grid.height - 1);
    }

    // Every cell within `radius` metres of a point, with how far in it is.
    near(lon, lat, radius) {
        const mPerLon = 111320 * Math.cos(lat * Math.PI / 180);
        const dLon = radius / mPerLon;
        const dLat = radius / 110540;
        const [w, s, e, n] = this.grid.bbox;
        const i0 = Math.max(0, Math.floor((lon - dLon - w) / (e - w) * (this.grid.width - 1)));
        const i1 = Math.min(this.grid.width - 1,
            Math.ceil((lon + dLon - w) / (e - w) * (this.grid.width - 1)));
        const j0 = Math.max(0, Math.floor((n - lat - dLat) / (n - s) * (this.grid.height - 1)));
        const j1 = Math.min(this.grid.height - 1,
            Math.ceil((n - lat + dLat) / (n - s) * (this.grid.height - 1)));
        const out = [];
        for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const dx = (this.lonOf(i) - lon) * mPerLon;
                const dz = (this.latOf(j) - lat) * 110540;
                const d = Math.hypot(dx, dz);
                if (d <= radius) out.push({ k: j * this.grid.width + i, i, j, d });
            }
        }
        return out;
    }

    // ------------------------------------------------------------- strokes

    begin() { this.stroke = new Map(); }

    // Undo is per stroke, so every cell a stroke is about to change keeps what
    // it was before the stroke started, once.
    remember(k) {
        if (this.stroke && !this.stroke.has(k)) this.stroke.set(k, this.grid.data[k]);
    }

    end() {
        if (this.stroke?.size) {
            this.strokes.push(this.stroke);
            this.undone.length = 0;
        }
        this.stroke = null;
    }

    undo() {
        const s = this.strokes.pop();
        if (!s) return false;
        const back = new Map();
        for (const [k, was] of s) { back.set(k, this.grid.data[k]); this.grid.data[k] = was; }
        this.undone.push(back);
        this.mark(s);
        return true;
    }

    redo() {
        const s = this.undone.pop();
        if (!s) return false;
        const back = new Map();
        for (const [k, was] of s) { back.set(k, this.grid.data[k]); this.grid.data[k] = was; }
        this.strokes.push(back);
        this.mark(s);
        return true;
    }

    // The box everything shaped since the last save falls in, so the save only
    // dirties the tiles that actually moved.
    mark(cells) {
        for (const k of cells.keys()) {
            const i = k % this.grid.width;
            const j = (k - i) / this.grid.width;
            const lon = this.lonOf(i);
            const lat = this.latOf(j);
            this.touched = this.touched
                ? [Math.min(this.touched[0], lon), Math.min(this.touched[1], lat),
                    Math.max(this.touched[2], lon), Math.max(this.touched[3], lat)]
                : [lon, lat, lon, lat];
        }
    }

    // ------------------------------------------------------------ the saving

    async save() {
        const bytes = writeR32(this.grid);
        const sha = await sha256(bytes);
        await put(bytes, sha);
        const got = await api.rpc('save_height_edit', {
            area: this.area.id, sha256: sha, rev: this.rev,
            bbox: this.touched ?? null,
        });
        this.rev = Number(got.rev);
        this.strokes.length = 0;
        this.undone.length = 0;
        this.touched = null;
        return got;
    }
}

export const ringsOf = (outline) => {
    if (!outline) return [];
    if (outline.type === 'Polygon') return outline.coordinates;
    if (outline.type === 'MultiPolygon') return outline.coordinates.flat();
    return [];
};

// The store answers 201 for bytes it did not have, 409 for a path it already
// holds and 403 once the sha is an artifact; only the first has anything left
// to register (Invariant 1).
async function put(bytes, sha) {
    const res = await fetch(`${api.endpoints().files}/assets/${sha}.r32`, {
        method: 'PUT',
        headers: { 'X-Sha256': sha, Authorization: `Bearer ${api.token()}`,
            'Content-Type': 'application/octet-stream' },
        body: bytes,
    });
    if (![201, 204, 403, 409].includes(res.status)) {
        throw new Error(`PUT /assets/${sha}.r32 -> ${res.status}`);
    }
    if (res.status === 403) return sha;
    await api.rpc('register_artifact',
        { sha256: sha, kind: 'height_edit', bytes: bytes.byteLength, algo_version: 'r32-v1' });
    return sha;
}
