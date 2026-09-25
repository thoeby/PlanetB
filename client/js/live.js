// live.js — what a placed thing is doing right now.
//
// TASKS-foundation.md FND.15. A tile is the world as it was compiled; a lamp
// being switched on is not a reason to compile it again. So what a thing is
// told lives beside it in `live_state` (db/0169) and is drawn over the splats
// here: a light's head lit in its own colour, a screen showing the picture its
// `image` port names, a door or a rotor at the pose its port puts it in.
//
// The values are asked for by "what has changed since the number I last saw",
// for things within five hundred metres, every three seconds, and not at all
// while nobody is looking at the tab.

import * as api from './api.js';

export const NEAR_M = 500;
export const EVERY_MS = 3000;

const DEFAULT_LIGHT = '#ffd9a0';

export const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

// #rrggbb as three numbers between nought and one. Anything else is the warm
// white a street lamp is when nobody said otherwise.
export function rgb(value, fallback = DEFAULT_LIGHT) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(value ?? ''));
    const use = m ? m : /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(fallback);
    return [1, 2, 3].map((i) => parseInt(use[i], 16) / 255);
}

// The markings of a product, in the shape this file wants: every marked part
// with the ports that drive it (db/0160, client/lib/marks.js).
export function marksByPart(parts) {
    const out = new Map();
    for (const p of parts?.parts ?? []) {
        out.set(p.name, { ...p,
            ports: (parts.ports ?? []).filter((q) => q.drives?.part === p.name) });
    }
    return out;
}

// What the port driving this part in this way is set to — what the world last
// recorded, or what the product says it starts out as.
export function saidTo(mark, values, what) {
    const port = mark?.ports?.find((p) => p.drives?.what === what);
    if (!port) return undefined;
    const said = values?.[port.name];
    return said === undefined || said === null ? port.default : said;
}

// A light: on or off, what colour, and how bright.
export function lightOf(mark, values) {
    return {
        on: truthy(saidTo(mark, values, 'light')),
        colour: rgb(saidTo(mark, values, 'colour') ?? mark.colour),
        intensity: Math.max(0, Number(saidTo(mark, values, 'intensity')
            ?? mark.intensity ?? 1)),
    };
}

// A screen: the sha256 of the picture it shows, or nothing.
export function screenOf(mark, values) {
    const said = String(saidTo(mark, values, 'texture') ?? '');
    return /^[0-9a-f]{64}$/.test(said) ? said : null;
}

// A door or a rotor: how far round its own axis it is put. `open` is nought to
// one of the range the maker gave it.
export function poseOf(mark, values) {
    const open = Number(saidTo(mark, values, 'pose') ?? 0);
    const range = Number(mark.range ?? 90);
    const axis = ['x', 'y', 'z'].includes(mark.axis) ? mark.axis : 'y';
    return { axis, degrees: Math.max(0, Math.min(1, open || 0)) * range };
}

// ------------------------------------------------------------------ the poll

// Everything live near where somebody is standing, merged into what this tab
// already knows. The rev is the world's own counter, so a tab that has been
// away asks once and is told only what it missed.
export class LiveWorld {
    constructor({ rpc = api.rpc } = {}) {
        this.rpc = rpc;
        this.since = 0;
        // `${instance}|${port}` -> value
        this.values = new Map();
        // `${instance}|${port}` -> { value, clock, start, rev } (LV.1: a
        // motion is evaluated from the clock of its write and where it began)
        this.rows = new Map();
        this.changed = 0;
    }

    // Every row of one thing, as client/lib/joint.js wants them.
    rowsOf(id) {
        const out = [];
        for (const [key, row] of this.rows) {
            const [who, port] = key.split('|');
            if (who === id) out.push({ ...row, port });
        }
        return out;
    }

    at(id, port) { return this.values.get(`${id}|${port}`); }

    // Everything one thing is set to, as the drawing wants it.
    of(id) {
        const out = {};
        for (const [key, value] of this.values) {
            const [who, port] = key.split('|');
            if (who === id) out[port] = value;
        }
        return out;
    }

    take(rows) {
        let n = 0;
        for (const row of rows ?? []) {
            this.values.set(`${row.instance}|${row.port}`, row.value);
            this.rows.set(`${row.instance}|${row.port}`, { value: row.value,
                clock: row.clock ?? null, start: row.start ?? null, rev: row.rev });
            this.since = Math.max(this.since, Number(row.rev) || 0);
            n += 1;
        }
        this.changed += n;
        return n;
    }

    async poll(lon, lat, metres = NEAR_M) {
        const rows = await this.rpc('live_near',
            { p_lon: lon, p_lat: lat, p_metres: metres, p_since: this.since })
            .catch(() => []);
        return this.take(rows);
    }

    // What this tab wrote itself, shown at once rather than three seconds
    // later: the player pressed the switch and the lamp is theirs.
    wrote(id, port, value, rev = 0, clock = null, start = null) {
        this.values.set(`${id}|${port}`, value);
        this.rows.set(`${id}|${port}`, { value, clock, start, rev });
        this.since = Math.max(this.since, Number(rev) || 0);
        this.changed += 1;
    }

    forget() { this.values.clear(); this.rows.clear(); this.since = 0; }
}
