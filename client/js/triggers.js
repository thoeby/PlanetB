// triggers.js — noticing that somebody set a thing off, and saying so once.
//
// TASKS-live.md LV.2. A product declares what sets it off, as `{kind,
// params}` in its markings (db/0203); what happens next is a flow's, on a
// process server. The page is only the witness: it works out that a firing
// happened and tells the world through `emit_trigger`, once. The kinds are
// here and nowhere else — a new one is a new branch below, never a row.
//
//   click {}           the thing was clicked, out of build mode
//   near  {m}          somebody came within m metres
//   far   {m}          somebody who was within m metres went further
//   key   {key, when}  a key was pressed (`down`) or let go (`up`) within reach
//   use   {part}       Use was pressed within reach, looking at that part
//
// Pure apart from `rpc`: the caller says where the player is and what is near.

import * as api from './api.js';

export const KINDS = ['click', 'near', 'far', 'key', 'use'];
// How near a key or Use reaches: an arm's length and a step.
export const REACH_M = 3;
// The same firing of the same thing, twice in this long, is the same firing.
const AGAIN_S = 1;

export const triggersOf = (row) => (row?.parts?.triggers ?? [])
    .filter((t) => t && typeof t.kind === 'string');

const metres = (t, fallback) => {
    const m = Number(t.params?.m);
    return Number.isFinite(m) && m > 0 ? m : fallback;
};

// Which near/far edges a step from `was` to `now` metres away crosses.
export function edges(triggers, was, now) {
    const out = [];
    for (const t of triggers) {
        const m = metres(t, 5);
        if (t.kind === 'near' && now <= m && !(was <= m)) out.push(t);
        if (t.kind === 'far' && now > m && was <= m) out.push(t);
    }
    return out;
}

export class Triggers {
    constructor({ rpc = api.rpc, clock = () => Date.now() / 1000, say = () => {} } = {}) {
        this.rpc = rpc;
        this.clock = clock;
        this.say = say;
        this.distance = new Map();      // instance id -> metres last seen at
        this.last = new Map();          // `${id}|${kind}` -> clock of last firing
        this.fired = [];                // what this tab said, newest last
    }

    // Once a frame or so: every thing near, and how far it is now.
    // `things` is [{row, metres}].
    move(things) {
        const seen = new Set();
        const out = [];
        for (const { row, metres: now } of things) {
            seen.add(row.id);
            const was = this.distance.get(row.id);
            this.distance.set(row.id, now);
            for (const t of edges(triggersOf(row), was, now)) out.push(this.fire(row, t.kind));
        }
        for (const id of [...this.distance.keys()]) if (!seen.has(id)) this.distance.delete(id);
        return Promise.all(out);
    }

    click(row) {
        return triggersOf(row).some((t) => t.kind === 'click') ? this.fire(row, 'click')
            : Promise.resolve(null);
    }

    // A key, down or up, for everything within reach that listens for it.
    key(code, when, things) {
        const out = [];
        for (const { row, metres: m } of things) {
            if (m > REACH_M) continue;
            for (const t of triggersOf(row)) {
                if (t.kind !== 'key') continue;
                const want = String(t.params?.key ?? '').toLowerCase();
                if (want && want === String(code).toLowerCase()
                    && (t.params?.when ?? 'down') === when) out.push(this.fire(row, 'key'));
            }
        }
        return Promise.all(out);
    }

    // Use: the nearest thing within reach with a `use` trigger, about its part.
    use(things) {
        const near = things.filter(({ row, metres: m }) => m <= REACH_M
            && triggersOf(row).some((t) => t.kind === 'use'))
            .sort((a, b) => a.metres - b.metres)[0];
        if (!near) return Promise.resolve(null);
        const t = triggersOf(near.row).find((q) => q.kind === 'use');
        return this.fire(near.row, 'use', t.params?.part ?? null);
    }

    // What the page can offer right now: a thing within reach that listens for
    // Use or for a key, so the key is on the screen before anybody presses it.
    offers(things) {
        const out = [];
        for (const { row, metres: m } of things) {
            if (m > REACH_M) continue;
            for (const t of triggersOf(row)) {
                if (t.kind === 'use') out.push({ row, key: 'E', what: 'use' });
                if (t.kind === 'key' && t.params?.key) {
                    out.push({ row, key: String(t.params.key).toUpperCase(), what: 'key' });
                }
            }
        }
        return out;
    }

    async fire(row, kind, part = null) {
        const now = this.clock();
        const key = `${row.id}|${kind}`;
        if (now - (this.last.get(key) ?? -Infinity) < AGAIN_S) return null;
        this.last.set(key, now);
        const name = row.name ?? row.san;
        try {
            const id = await this.rpc('emit_trigger',
                { p_instance: row.id, p_kind: kind, p_part: part, p_clock: now });
            this.fired.push({ id, instance: row.id, kind, at: now });
            this.say(`You set off ${name} (${kind})`);
            return id;
        } catch (err) {
            this.say(String(err.body?.message ?? err.message ?? err), true);
            return null;
        }
    }
}
