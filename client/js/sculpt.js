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

// One brush pulls the ground up and, with Shift held, pushes it down
// (PLAN-editors.md D6): Lower was a second tool for the same stroke.
export const BRUSHES = [
    { id: 'raise', words: 'Raise', key: 'r' },
    { id: 'smooth', words: 'Smooth', key: 'm' },
    { id: 'flatten', words: 'Flatten', key: 'g' },
    { id: 'level', words: 'Level', key: 'l' },
    { id: 'line', words: 'Along line', key: 'b' },
    // Your shaping rubbed out under the brush, back to the elevation.
    { id: 'putback', words: 'Put back', key: 'x' },
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
        // What the world holds, so what is shaped but not saved can be told
        // apart from it (Blueprint hatches it: client/lib/clay.js).
        this.saved = grid.data.slice();
    }

    savedAt(lon, lat) { return sampleR32({ ...this.grid, data: this.saved }, lon, lat); }

    // What the land is shaped into right now, as the world holds it.
    static async load(area) {
        const grid = gridFor(box(area.bbox), cellFor(area.bbox));
        // Who shaped it last and when (db/0176), so the panel can say what was
        // already here. It read the revision and nothing else, and a land
        // somebody flattened last week looked like one nobody had touched.
        const was = await api.rpc('shaping_of', { p_area: area.id }).catch(() => null);
        const made = (g, rev) => Object.assign(new Shaping(area, g, rev), { was });
        if (!was?.sha256) return made(grid, Number(was?.rev ?? 0));
        const res = await fetch(`${api.endpoints().files}/assets/${was.sha256}.r32`)
            .catch(() => null);
        if (!res?.ok) return made(grid, Number(was.rev));
        const got = readR32(new Uint8Array(await res.arrayBuffer()));
        return made(got.width === grid.width && got.height === grid.height
            ? got : grid, Number(was.rev));
    }

    // What this land's ground is, against the elevation the operator gave: how
    // many cells have been moved at all, and how far up and down. The page had
    // no way to say it, so "have I shaped this, and by how much" could only be
    // answered by dragging a brush and watching.
    summary() {
        const { data } = this.grid;
        let cells = 0;
        let lowest = 0;
        let highest = 0;
        for (let k = 0; k < data.length; k++) {
            const v = data[k];
            if (!v) continue;
            cells += 1;
            if (v < lowest) lowest = v;
            if (v > highest) highest = v;
        }
        return { cells, of: data.length, lowest, highest,
            metres: Math.round(cells * this.grid.cell * this.grid.cell) };
    }

    // How much earth the shaping moves altogether, in cubic metres: every
    // cell's height off the elevation times its area, raised and lowered
    // counted apart (PLAN-editors idea 7).
    earth() {
        const { data, cell } = this.grid;
        let raised = 0;
        let lowered = 0;
        for (let k = 0; k < data.length; k++) {
            if (data[k] > 0) raised += data[k];
            else lowered -= data[k];
        }
        return { raised: raised * cell * cell, lowered: lowered * cell * cell };
    }

    // The ground put back as the operator gave it: one stroke, so it is undone
    // like any other and only reaches the world when it is saved. Clearing was
    // possible only by raising and lowering every cell by hand.
    clear() {
        const { data } = this.grid;
        this.begin({ brush: 'putback', words: 'Put back the land' });
        let moved = 0;
        for (let k = 0; k < data.length; k++) {
            if (!data[k]) continue;
            this.remember(k);
            data[k] = 0;
            moved += 1;
        }
        // Every cell of the land, because the whole of it may have moved.
        this.mark(this.stroke ?? new Map());
        this.touched = [...box(this.area.bbox)];
        this.end();
        return moved;
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

    // `note` is what the history says about the stroke (EDT.9): which brush,
    // how big, and — once it ends — how far it moved the ground.
    begin(note = {}) {
        this.stroke = new Map();
        this.stroke.note = { at: Date.now(), ...note };
    }

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
        this.undone.push(this.swap(s));
        return true;
    }

    redo() {
        const s = this.undone.pop();
        if (!s) return false;
        this.strokes.push(this.swap(s));
        return true;
    }

    // A stroke's cells put back to what it remembered, and what they were
    // kept in its place, so the same stroke can go the other way.
    swap(s) {
        const back = new Map();
        back.note = s.note;
        for (const [k, was] of s) { back.set(k, this.grid.data[k]); this.grid.data[k] = was; }
        this.mark(s);
        return back;
    }

    // Undo back to the `n`th stroke (it stays), or redo forward to it.
    undoTo(n) {
        let moved = 0;
        while (this.strokes.length > n && this.undo()) moved += 1;
        return moved;
    }

    redoTo(n) {
        let moved = 0;
        while (this.strokes.length < n && this.redo()) moved += 1;
        return moved;
    }

    // Every stroke since the last save, newest first: the ones done, then the
    // ones undone (struck through until a new stroke replaces them).
    history() {
        const done = this.strokes.map((s, i) => ({ ...s.note, done: true, n: i + 1 }));
        const undone = this.undone.map((s, i) => ({ ...s.note, done: false,
            n: this.strokes.length + this.undone.length - i }));
        return [...undone.reverse(), ...done].sort((a, b) => b.n - a.n);
    }

    // The box everything shaped since the last save falls in, so the save only
    // dirties the tiles that actually moved.
    mark(cells) {
        for (const k of (cells.keys ? cells.keys() : cells)) {
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
        this.saved = this.grid.data.slice();
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
