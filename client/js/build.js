// build.js — build mode's policy: where the player is allowed to build, where
// the thing they are placing lands, and what the world is asked to record.
//
// No DOM and no engine: everything here is a function of the terrain and the
// API, so it can be unit-tested without a GPU. buildui.js owns the panel and
// the input, and row-level security owns the answer — an INSERT into `instance`
// succeeds only where `is_area_writer` says so (Invariant 6). area_at() is a
// courtesy so the panel can say "not your land" before the database does.

import * as api from './api.js';

// What a placement snaps to when snapping is on: a quarter metre, fifteen
// degrees, a tenth of the asset's own size.
export const SNAP = { move: 0.25, turn: Math.PI / 12, scale: 0.1 };

export const snapTo = (value, step) => (step ? Math.round(value / step) * step : value);

// --------------------------------------------------------------- the ray

// Marches the camera's forward ray until it passes under the ground, then
// bisects. The heightfield is a grid, not a mesh, so there is nothing to
// intersect analytically — and this is the same field the player walks on, so
// what you place is where you stand.
export function raycastGround(terrain, from, dir, { far = 400, step = 0.5 } = {}) {
    const at = (t) => ({ x: from.x + dir.x * t, y: from.y + dir.y * t, z: from.z + dir.z * t });
    const under = (p) => {
        const h = terrain.heightAt(p);
        return h === null ? null : p.y - h;
    };
    let last = under(from);
    if (last === null) return null;
    for (let t = step; t <= far; t += step) {
        const p = at(t);
        const d = under(p);
        if (d === null) return null;
        if (d <= 0 && last > 0) return bisect(at, t - step, t, under);
        last = d;
    }
    return null;
}

function bisect(at, lo, hi, under, rounds = 24) {
    for (let i = 0; i < rounds; i++) {
        const mid = (lo + hi) / 2;
        if (under(at(mid)) > 0) lo = mid; else hi = mid;
    }
    const p = at(hi);
    return { ...p, t: hi };
}

// --------------------------------------------------------------- the world

export const areasAt = (lon, lat) => api.rpc('area_at', { lon, lat });
export const myAreas = () => api.rpc('my_areas');
export const tilesAt = (lon, lat, maxZ = 14) => api.rpc('tiles_at', { lon, lat, max_z: maxZ });

const FIELDS = 'id,area_id,san,lon,lat,h,yaw,pitch,roll,scale,props,rev';

// Every instance near the player, so build mode can show what is already there
// and let it be picked up again. A degree of latitude is 111 km; the box is
// square in metres, which is close enough for a picker.
export function nearbyInstances(lon, lat, metres = 300) {
    const dLat = metres / 111320;
    const dLon = dLat / Math.max(0.05, Math.cos(lat * Math.PI / 180));
    return api.select('instance', {
        select: FIELDS,
        lon: `gte.${lon - dLon}`, lat: `gte.${lat - dLat}`,
        and: `(lon.lte.${lon + dLon},lat.lte.${lat + dLat},deleted_at.is.null)`,
        limit: '200',
    });
}

// What a step is, in the unit the chosen mode moves in — the number the two
// buttons beside it add and take away. Fine steps are a fifth of it.
const STEP = { move: SNAP.move, turn: SNAP.turn, size: SNAP.scale };

export function stepWords(state) {
    const size = state.snap ? STEP[state.mode] : STEP[state.mode] / 5;
    if (state.mode === 'turn') return `step ${size}°`;
    if (state.mode === 'size') return `step ${size}×`;
    return `step ${size.toFixed(2)} m`;
}

// ------------------------------------------------------------------- edits

// SPEC §0.3: an object being positioned is `placing` — not saved, and only
// this tab sees it. It becomes `saved` when the player presses Save, and only
// then does anybody else see the model. So a placement is local until then,
// and moving one moves the local copy.
let placingSeq = 0;
const localId = () => `placing:${++placingSeq}`;

// One place to make a change and one place to undo it. The undo stack is
// client-side and dies with the tab (TASKS.md WP4.2) — the world's own history
// is `rev` and, from WP4.3, proposals.
export class Edits {
    // `writes` is api.js's insert/update/remove. It is injected rather than
    // imported so the undo stack can be tested without an HTTP server: what is
    // being tested is the order of the inverses, not the transport.
    constructor({ onChange, writes } = {}) {
        this.stack = [];
        // Placed in this tab and not yet saved (SPEC §0.3 `placing`).
        this.pending = [];
        this.onChange = onChange ?? (() => {});
        this.api = writes ?? { insert: api.insert, update: api.update, remove: api.remove };
    }

    get depth() { return this.stack.length; }

    get unsaved() { return this.pending.length; }

    static isPlacing(row) { return String(row?.id ?? '').startsWith('placing:'); }

    place(areaId, san, at, pose = {}) {
        const row = {
            id: localId(), area_id: areaId, san,
            lon: at.lon, lat: at.lat, h: at.h ?? 0,
            yaw: pose.yaw ?? 0, pitch: pose.pitch ?? 0, roll: pose.roll ?? 0,
            scale: pose.scale ?? 1, placing: true, sha256: pose.sha256,
        };
        this.pending.push(row);
        this.stack.push({ undo: 'unplace', row });
        this.onChange(row);
        return row;
    }

    // Save is what the rest of the world sees: until it, nothing has been
    // written and nothing outside this tab knows about it.
    async save() {
        if (!this.pending.length) return { objects: 0 };
        const rows = await this.api.insert('instance', this.pending.map((r) => ({
            area_id: r.area_id, san: r.san, lon: r.lon, lat: r.lat, h: r.h,
            yaw: r.yaw, pitch: r.pitch, roll: r.roll, scale: r.scale,
        })), { select: FIELDS });
        const saved = this.pending.length;
        this.pending = [];
        // What was placed in this tab is now the world's: an undo after a save
        // has to take the row away, not the local copy.
        this.stack = this.stack.filter((e) => e.undo !== 'unplace'
            && e.undo !== 'relocal');
        for (const row of rows ?? []) this.stack.push({ undo: 'delete', row });
        this.onChange(rows?.[0]);
        return { objects: saved, rows: rows ?? [] };
    }

    // A pose change is one PATCH, and its inverse is the row as it was. On
    // something still being placed there is nothing to PATCH: the local copy
    // moves.
    async transform(row, patch) {
        if (Edits.isPlacing(row)) {
            const local = this.pending.find((r) => r.id === row.id);
            if (!local) return row;
            const before = { ...local };
            Object.assign(local, patch);
            this.stack.push({ undo: 'relocal', row: local, before });
            this.onChange(local);
            return local;
        }
        return this.patch(row, patch);
    }

    async patch(row, patch) {
        const before = { yaw: row.yaw, pitch: row.pitch, roll: row.roll, scale: row.scale,
            lon: row.lon, lat: row.lat, h: row.h };
        const [next] = await this.api.update('instance',
            { id: `eq.${row.id}`, select: FIELDS }, patch);
        this.stack.push({ undo: 'restore', row: next, before });
        this.onChange(next);
        return next;
    }

    // Deleting is a real DELETE: `deleted_at` is for a tombstone the world has
    // to keep, and a misplaced bench is not that. The trigger dirties the tile
    // either way.
    async remove(row) {
        if (Edits.isPlacing(row)) {
            this.pending = this.pending.filter((r) => r.id !== row.id);
            this.stack = this.stack.filter((e) => e.row?.id !== row.id);
            this.onChange(row);
            return row;
        }
        await this.api.remove('instance', { id: `eq.${row.id}` });
        this.stack.push({ undo: 'place', row });
        this.onChange(row);
        return row;
    }

    async undo() {
        const last = this.stack.pop();
        if (!last) return null;
        const back = await this.apply(last);
        this.onChange(back ?? last.row);
        return back;
    }

    // Undoing must not itself be undoable, so nothing here pushes.
    async apply(entry) {
        if (entry.undo === 'unplace') {
            this.pending = this.pending.filter((r) => r.id !== entry.row.id);
            return null;
        }
        if (entry.undo === 'relocal') {
            const local = this.pending.find((r) => r.id === entry.row.id);
            if (local) Object.assign(local, entry.before);
            return local ?? null;
        }
        if (entry.undo === 'delete') {
            await this.api.remove('instance', { id: `eq.${entry.row.id}` });
            return null;
        }
        if (entry.undo === 'restore') {
            const [row] = await this.api.update('instance',
                { id: `eq.${entry.row.id}`, select: FIELDS }, entry.before);
            return row;
        }
        const [row] = await this.api.insert('instance', [{
            area_id: entry.row.area_id, san: entry.row.san,
            lon: entry.row.lon, lat: entry.row.lat, h: entry.row.h,
            yaw: entry.row.yaw, pitch: entry.row.pitch, roll: entry.row.roll,
            scale: entry.row.scale,
        }], { select: FIELDS });
        return row;
    }
}
