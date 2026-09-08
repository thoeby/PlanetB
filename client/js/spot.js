// spot.js — the check an owner's own tab does for free.
//
// Three strangers looked at a tile once, when it was made (Invariant 8). The
// people whose ground it stands on look at it every time they walk past, and
// their tab has already downloaded it. So when the streamer loads a tile this
// user did not publish, inside an area they may write, and they have not
// checked it for a week, the tab checks it again and says so.
//
// The server decides all of that: spot_due (db/0018_spot.sql) answers with what
// checking this tile would consist of, or with nothing. Nothing here is trusted
// and nothing here is free to make a claim the server did not ask for.

import { InputCache, resolveInputs } from './inputs.js';
import { spawnAtomWorker } from './work.js';

export const SWEEP_MS = 60_000;

export class SpotChecker {
    constructor({ api, apiUrl, filesUrl, spawn = spawnAtomWorker, cache, fetchFn,
        log = () => {}, timers = globalThis } = {}) {
        this.api = api;
        this.apiUrl = apiUrl ?? '';
        this.filesUrl = filesUrl ?? '';
        this.spawn = spawn;
        this.cache = cache ?? new InputCache({ filesUrl, fetchFn });
        this.log = (rec) => log({ t: Date.now(), ...rec });
        this.timers = timers;
        this.seen = new Set();
        this.who = null;
        this.checked = 0;
        this.flagged = 0;
        this.timer = null;
    }

    // One tile. Returns what was done, or null when the server says nothing is
    // due — which is the usual answer.
    async check(row) {
        const [due] = await this.api.rpc('spot_due',
            { z: row.z, x: row.x, y: row.y }) ?? [];
        if (!due) return null;
        this.checked += 1;
        if (due.kind === 'hash') {
            const again = await this.api.rpc('recheck_atom', { atom_id: due.atom_id });
            this.log({ event: 'spot-recheck', atom: due.atom_id, tile: keyOf(row), again });
            return { kind: 'hash', atom: due.atom_id, again };
        }
        return this.look(row, due);
    }

    // The perceptual one: the same atom module a verify worker runs, on the
    // same inputs, submitted as a spot check rather than as an atom's answer.
    async look(row, due) {
        const atom = { id: due.atom_id, op: 'verify', seed: 0,
            inputs: due.inputs, params: due.params };
        const inputs = await this.cache.load(await resolveInputs(this.api, due.inputs));
        const worker = this.spawn();
        let out;
        try {
            out = await worker.run({ atom, inputs, apiUrl: this.apiUrl,
                filesUrl: this.filesUrl }, (rec) => this.log({ tile: keyOf(row), ...rec }));
        } finally {
            worker.terminate();
        }
        const state = await this.api.rpc('submit_verification', {
            atom_id: due.atom_id, passed: out.result.passed === true,
            metrics: out.result, spot: true,
        });
        if (!out.result.passed) this.flagged += 1;
        this.log({ event: 'spot-check', atom: due.atom_id, tile: keyOf(row),
            psnr: out.result.psnr, passed: out.result.passed, state });
        return { kind: 'perceptual', atom: due.atom_id, passed: out.result.passed, state };
    }

    // At most one tile per sweep: this is a courtesy the tab pays for out of
    // the same budget it is rendering with.
    async sweep(rows) {
        const token = this.api.token?.();
        if (!token) return null;
        // Whose tiles these are is the whole question, so a tab that has
        // changed hands has seen nothing.
        if (token !== this.who) {
            this.who = token;
            this.seen.clear();
        }
        for (const row of rows ?? []) {
            const k = `${keyOf(row)}/${row.sog_sha256 ?? ''}`;
            if (this.seen.has(k)) continue;
            this.seen.add(k);
            const done = await this.check(row).catch((err) => {
                this.log({ event: 'spot-failed', tile: keyOf(row),
                    err: String(err?.message ?? err) });
                return null;
            });
            if (done) return done;
        }
        return null;
    }

    // The tiles the streamer has actually placed, which are the ones this tab
    // has downloaded and is showing. A check costs about what rendering a frame
    // does, so it waits for the first sweep and stands aside entirely while the
    // tab is compiling something for somebody else.
    start(streamer, { everyMs = SWEEP_MS, busy = () => false } = {}) {
        if (this.timer) return;
        this.timer = this.timers.setInterval(() => {
            if (busy()) return;
            this.sweep(loaded(streamer)).catch(
                (err) => this.log({ event: 'spot-failed', err: String(err?.message ?? err) }));
        }, everyMs);
    }

    stop() {
        this.timers.clearInterval(this.timer);
        this.timer = null;
    }
}

const keyOf = (row) => `${row.z}/${row.x}/${row.y}`;

export const loaded = (streamer) => [...(streamer?.entries?.values() ?? [])]
    .filter((e) => e.entity && e.row?.sog_sha256).map((e) => e.row);
