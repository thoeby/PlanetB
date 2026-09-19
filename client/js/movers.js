// movers.js — the things that move by the world's own clock (FND.16).
//
// A mover is a line, a speed and a timetable (db/0171). Where it is at any
// moment is worked out from those three and the clock, by client/lib/route.js
// — nothing is stored per frame and nothing is written as it moves.
//
// The clock is the world's, not the tab's. Two players standing at the same
// stop see the same bus at the same second because both measure their own
// clock against `world_clock()` once at load and use the difference from then
// on; a laptop whose clock is two minutes out sees the same bus as everybody
// else.

import * as api from './api.js';
import { positionAt } from '../lib/route.js';

export const REACH_M = 2000;
export const EVERY_MS = 10_000;

export class Movers {
    constructor({ rpc = api.rpc, now = () => Date.now() } = {}) {
        this.rpc = rpc;
        this.now = now;
        this.rows = new Map();
        // seconds to add to this tab's own clock to get the world's
        this.offset = 0;
        this.checked = false;
    }

    // Once, at load: what time the world says it is, against what this tab
    // thinks. Asked again costs nothing but proves nothing — a clock that has
    // been measured has been measured.
    async sync() {
        const said = await this.rpc('world_clock', {}).catch(() => null);
        if (said === null) return false;
        this.offset = Number(said) - this.now() / 1000;
        this.checked = true;
        return true;
    }

    // The world's time, in seconds.
    clock() { return this.now() / 1000 + this.offset; }

    async near(lon, lat, metres = REACH_M) {
        const rows = await this.rpc('movers_near',
            { p_lon: lon, p_lat: lat, p_metres: metres }).catch(() => []);
        const seen = new Set();
        for (const row of rows ?? []) {
            seen.add(row.id);
            this.rows.set(row.id, row);
        }
        for (const id of [...this.rows.keys()]) if (!seen.has(id)) this.rows.delete(id);
        return this.rows.size;
    }

    // Where every one of them is, this second. A mover somebody paused stands
    // where it was when they did: its phase is what the pause froze.
    where(t = this.clock()) {
        const out = [];
        for (const row of this.rows.values()) {
            const at = positionAt(row.route, row.schedule, row.speed_kmh,
                row.paused ? 0 : t, Number(row.phase_s) || 0);
            if (at) out.push({ ...at, mover: row });
        }
        return out;
    }
}

// Making and changing one is the database's single verb (db/0172).
export const setMover = (id, fields) =>
    api.rpc('mover_set', { p_mover: id, p_fields: fields });

export const dropMover = (id) => api.rpc('mover_drop', { p_mover: id });

export const moversOn = (areaId) => api.rpc('movers_on', { p_area: areaId });
