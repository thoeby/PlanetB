// work.js — what a tab does when it decides to help compile the world.
//
// Claim an atom, fetch its inputs, run it in a Web Worker, upload what it made,
// register it, submit it. The server decides everything: claim_atom hands out
// the work, can_write authorises the upload, submit_atom runs the structural
// checks. Nothing here is trusted, and the server computes nothing on this
// tab's behalf (Invariant 9) — this is the compute.
//
// An atom module (client/atoms/{op}.js) exports:
//
//     export async function run({ atom, inputs, log, canvas }) => {
//         files: [{ ext, bytes, kind, algo_version, dir? }],
//         output: ext,          // which file is the atom's output; default the first
//         result: { ... },      // what submit_atom's structural rules read
//     }
//
// `inputs` is the atom's inputs with every artifact reference replaced by its
// bytes; `canvas(w, h)` makes an OffscreenCanvas; `log` takes a record.

import { sha256 } from '../lib/hash.js';
import { InputCache, resolveInputs } from './inputs.js';
import { lostInput, putFile } from './workstore.js';

// What this tab can do and how it runs an atom are client/js/workcaps.js;
// they are re-exported here because this is where every caller reaches for
// them, and because the file was over its four hundred lines.
export { probeCaps } from './workcaps.js';
import { ALGO, spawnAtomWorker } from './workcaps.js';
import { Shots } from './workshots.js';

export { ALGO, spawnAtomWorker };
export { Shots } from './workshots.js';

// How often a tab says it is still holding its claim. The world takes a claim
// back after `claim_patience` (db/0173), which an operator may turn down: at
// half a minute a tab survives a lease of one, and a tab whose timers the
// browser has throttled to once a minute still beats inside a lease of two.
const HEARTBEAT_MS = 30_000;
const IDLE_MS = 15_000;
// How long the pace may hold the loop back before it takes an atom anyway:
// standing aside for a tab being played is the point (WP5.2), standing aside
// for ever is not, and a machine that never reaches 30 fps would never claim.
const PACED_MAX_MS = 10_000;

// How many pieces a tab has in hand at once.
//
// A tile's three frames are three atoms with the same inputs and no order
// between them, and a tab did them one after another: claim, fetch, trace,
// hash, upload, submit, then the same again, with the network idle while the
// GPU worked and the GPU idle while it uploaded. Four lanes overlap those, so
// a tab that could fetch one frame while tracing another does.
//
// Four rather than as many as there are pieces: each lane holds an atom's
// inputs and its worker, and a z18's frames are a hundred megabytes each.
export const LANES = 4;

// Why this tab cannot build an atom, or null when it can. Which side is out
// of date is in the numbers: an atom newer than the tab means the page has
// been served a newer world since it loaded, and the fix is a reload; an atom
// older than the tab is a job opened before the world moved on, and the fix
// is the job's, not the player's (refresh_stale_jobs, db/0178).
export function wrongVersion(atom) {
    const mine = ALGO[atom.op];
    if (!mine || !atom.algo_version || atom.algo_version === mine) return null;
    const n = (v) => Number(/-v(\d+)$/.exec(v)?.[1] ?? 0);
    const said = `this tab builds ${mine}, and that atom asks for ${atom.algo_version}`;
    return n(atom.algo_version) > n(mine)
        ? `${said}: this page is out of date, reload it`
        : `${said}: that job is out of date, and the world will reopen it`;
}

// -------------------------------------------------------------------- the loop

export class WorkLoop {
    // `pace` is asked before every claim: it answers how long to wait before
    // starting the next atom, in milliseconds, and 0 for "go now". WP5.2 uses
    // it to keep a tab that is also being played above 30 fps; a worker tab
    // that is not rendering anything passes nothing and never waits.
    // `where` answers the player's position, which claim_atom orders by.
    constructor({ api, apiUrl, filesUrl, caps = {}, spawn = spawnAtomWorker, cache,
        log = () => {}, timers = globalThis, fetchFn, pace, where,
        lanes = LANES } = {}) {
        // How many atoms this tab runs at once, never fewer than one.
        this.lanes = Math.max(1, Math.round(lanes) || 1);
        this.pace = pace ?? (() => 0);
        this.where = where ?? (() => null);
        this.api = api;
        this.apiUrl = apiUrl ?? '';
        this.filesUrl = filesUrl ?? '';
        this.caps = caps;
        this.spawn = spawn;
        this.cache = cache ?? new InputCache({ filesUrl, fetchFn });
        this.fetchFn = fetchFn ?? ((...a) => fetch(...a));
        // The page's query string, for an atom with a knob (train_batch).
        this.knobs = Object.fromEntries(new URLSearchParams(globalThis.location?.search ?? ''));
        // The pictures this tab took of the tiles it worked on, so a panel
        // that is not the work panel can show them (client/js/workshots.js).
        this.shots = new Shots();
        this.log = (rec) => {
            const full = { t: Date.now(), ...rec };
            this.shots.saw(full);
            console.debug(JSON.stringify(full));
            log(full);
        };
        this.timers = timers;
        this.running = false;
        this.generation = 0;
        this.claimFailures = 0;
        // Every atom in hand, by id, and one of them — whichever was claimed
        // last — as `atom`, which is what the panels and the strip read.
        this.working = new Map();
        this.atom = null;
        this.done = 0;
        this.failed = 0;
        // The job this tab is working on, if somebody picked one out of the
        // pool (T6, client/js/pool.js). Null means take whatever pays best.
        this.job = null;
    }

    // Work this job and nothing else, or null for the whole pool.
    focus(job) {
        this.job = job ?? null;
        return this.job;
    }

    // One atom, start to finish. Returns the state submit_atom settled on, or
    // null when there was nothing to claim.
    async step() {
        const atom = await this.claim();
        if (!atom) return null;
        // An atom names the version of the code that may make it (Invariant
        // 2), and this tab has one version of each. claim_atom filters on
        // `caps.algo` (db/0178), so this is a world older than that or a tab
        // that lied about itself; either way the piece goes straight back,
        // not through fail_atom: refusing to run is not a failed attempt, and
        // three refusals must not mark the atom failed.
        const wrong = wrongVersion(atom);
        if (wrong) {
            this.log({ event: 'error', atom: atom.id, op: atom.op, err: wrong });
            await this.api.rpc('hand_back_atom', { atom_id: atom.id }).catch(() => {});
            throw new Error(wrong);
        }
        this.working.set(atom.id, atom);
        this.atom = atom;
        this.log({ event: 'claim', atom: atom.id, op: atom.op, job: atom.job_id });
        // A long atom saturates the machine, and a starved main thread is one
        // whose interval callbacks do not run: expire_claims would take the
        // atom away from a worker that is still doing it. So the atom's own
        // progress reports beat as well as the timer.
        let last = Date.now();
        // A beat that is refused is the world saying the claim is not this
        // tab's any more — expire_claims took it back, or another tab has it.
        // Finding that out at submit_atom, an hour of training later, is how
        // "the claim went quiet and the world took the piece back" reads as a
        // tile that will not render: the work is already lost when the beat is
        // refused, so the run stops here and says so.
        let refuse = () => {};
        // The worker the atom runs in, so losing the claim stops the run: a
        // race that rejects leaves the promise it lost to still running, and
        // a training run nobody will submit is the GPU for the next half hour.
        const held = { worker: null };
        const lost = new Promise((_, no) => { refuse = no; });
        // Nothing awaits `lost` on its own, and a rejection nobody is waiting
        // for yet is an unhandled rejection the moment it happens.
        lost.catch(() => {});
        const beat = () => {
            last = Date.now();
            this.api.rpc('heartbeat', { atom_id: atom.id }).catch((err) => {
                const said = String(err?.body?.message ?? err?.message ?? err);
                this.log({ event: 'beat-failed', atom: atom.id, err: said });
                if (/not claimed by you/.test(said)) {
                    refuse(new Error(`${said} — the world took this piece back while this`
                        + ' tab was still doing it, so nothing it computes can be'
                        + ' submitted. The claim lease may be shorter than the work:'
                        + ' see how big this world is built, in Work \u00b7 Settings.'));
                }
            });
        };
        const timer = this.timers.setInterval(beat, HEARTBEAT_MS);
        const progress = () => { if (Date.now() - last > HEARTBEAT_MS / 2) beat(); };
        try {
            const started = Date.now();
            // Racing the claim, not just the clock: an hour of training that
            // the world has already given to somebody else is an hour thrown
            // away, and the message at the end of it says nothing about why.
            const out = await Promise.race([this.compute(atom, progress, held), lost]);
            const state = await Promise.race([
                this.deliver(atom, out, (Date.now() - started) / 1000, progress), lost]);
            // Anything but 'verified' is submit_atom refusing the work: a
            // structural rule said no, the attempt was counted, and the atom
            // went back to `ready` for whoever claims next — this tab, in
            // practice, since it is the only one asking
            // (db/0094_apieceisnotleftinaclosedjob.sql). Counting that as done
            // and saying only 'ready' is how three rejected quarter-hours read
            // as three good ones.
            this[state === 'verified' ? 'done' : 'failed'] += 1;
            if (state === 'verified') {
                this.log({ event: 'submit', atom: atom.id, op: atom.op, state });
            } else {
                this.log({ event: 'rejected', atom: atom.id, op: atom.op, state,
                    rule: await this.broke(atom.id) });
            }
            return state;
        } catch (err) {
            this.failed += 1;
            // The message, not the stack: the panel is one line per event, and
            // the stack is the atom worker's, not this one's.
            // Whole, with its lines run together: a message that says what
            // each of three attempts complained about is useless cut at the
            // first newline, which is where its summary line ends.
            const reason = String(err?.message ?? err).replace(/\s*\n\s*/g, ' · ').slice(0, 600);
            this.log({ event: 'error', atom: atom.id, op: atom.op, err: reason,
                ...(err?.where ? { where: err.where } : {}) });
            await this.putDown(atom, reason, held);
            throw err;
        } finally {
            this.timers.clearInterval(timer);
            this.working.delete(atom.id);
            this.atom = this.working.values().next().value ?? null;
        }
    }

    // A failed run is stopped and its piece put back with the reason (db/0093);
    // a claim this tab lost is not its to put down.
    async putDown(atom, reason, held) {
        held.worker?.terminate();
        if (/not claimed by you/.test(reason)) return;
        await this.api.rpc('fail_atom', { atom_id: atom.id, reason }).catch(
            (e) => this.log({ event: 'fail-failed', atom: atom.id, err: String(e) }));
    }

    // Which rule refused an atom. submit_atom writes the name to `verification`
    // and returns only the atom's new state, so this is the one place the
    // reason exists at all; the rules themselves are in `structural_rule`.
    async broke(id) {
        const rows = await this.api.select('verification',
            { atom_id: `eq.${id}`, kind: 'eq.structural', passed: 'is.false',
                select: 'metrics', order: 'at.desc', limit: '1' }).catch(() => []);
        return rows[0]?.metrics?.rule ?? 'unknown';
    }

    // A claim that fails is nothing to do, not a crash: logged once per streak
    // of failures so a server that is down does not fill the log. The position
    // travels with the claim rather than with the worker row: a player moves,
    // and the nearest unfinished tile moves with them.
    async claim() {
        const near = this.where();
        const caps = near ? { ...this.caps, near } : this.caps;
        try {
            const atom = this.job
                ? await this.api.rpc('claim_for', { job_id: this.job, caps })
                : await this.api.rpc('claim_atom', { caps });
            this.claimFailures = 0;
            return atom?.id ? atom : null;
        } catch (err) {
            if (this.claimFailures++ === 0) {
                this.log({ event: 'claim-failed', err: String(err?.message ?? err) });
            }
            return null;
        }
    }

    // `progress` is the atom saying it is still alive, which beats if the last
    // beat is old enough. Every step that can take minutes without the atom
    // saying anything calls it: the timer alone is not enough, because a tab
    // nobody is looking at has its timers throttled and expire_claims takes the
    // work off it after five minutes (db/0005_state.sql). A z18's frames are a
    // hundred megabytes to fetch and its ply as much again to hash and upload,
    // and none of that says a word on its own.
    async compute(atom, progress = () => {}, held = {}) {
        // Running an older atom's inputs through this code would put bytes in
        // the world under a name that did not make them (Invariant 2).
        const wrong = wrongVersion(atom);
        if (wrong) throw new Error(wrong);
        const resolved = await resolveInputs(this.api, atom.inputs);
        progress();
        const inputs = await this.cache.load(resolved).catch(
            async (err) => { throw await lostInput(this, err); });
        progress();
        const worker = this.spawn();
        held.worker = worker;
        try {
            const out = await worker.run(
                { atom, inputs, apiUrl: this.apiUrl, filesUrl: this.filesUrl,
                    knobs: this.knobs },
                (rec) => { progress(); this.log({ atom: atom.id, ...rec }); });
            // A verify atom answers a question and writes nothing; every other
            // op has to have made something (client/atoms/verify.js).
            if (!out || (!out.files?.length && out.output !== null)) {
                throw new Error(`${atom.op} produced no files`);
            }
            return out;
        } finally {
            worker.terminate();
        }
    }

    // Upload, register, submit — in that order, because register_artifact is
    // what makes an upload citable and submit_atom reads the artifact's size.
    async deliver(atom, out, seconds, progress = () => {}) {
        const written = [];
        for (const file of out.files ?? []) {
            progress();
            const sha = await sha256(file.bytes);
            progress();
            written.push({ sha, ext: file.ext, path: await this.upload(atom, file, sha) });
            progress();
        }
        const pick = written.find((w) => w.ext === out.output) ?? written[0] ?? null;
        // Where the bytes went travels with the atom: an artifact is written
        // once, so a later atom that produces the same bytes cannot put them
        // under its own job directory, and its consumer has to be told where
        // they really are (client/js/inputs.js).
        const result = { gpu_seconds: seconds, ...out.result,
            path: pick?.path ?? null, files: written };
        progress();
        const state = await this.api.rpc('submit_atom',
            { atom_id: atom.id, output_sha256: pick?.sha ?? null, result });
        if (state === 'verified' && pick) await this.publish(atom, result, pick.sha);
        return state;
    }

    // The tile's candidate moves last, by the worker that made the .sog and
    // only if the world has not moved on: publish_tile is a compare-and-swap
    // (Invariant 3). What lands is a candidate, whatever the op: a person
    // publishes it (T7, db/0044_permission.sql).
    async publish(atom, result, sha) {
        if (atom.op !== 'sog' || !result.manifest || !result.tile) return;
        const { z, x, y, target_version: version } = result.tile;
        const done = await this.api.rpc('publish_tile', {
            z, x, y, target_version: version, sog_sha256: sha, manifest: result.manifest,
        }).catch((err) => {
            this.log({ event: 'publish-failed', atom: atom.id, err: String(err.message ?? err) });
            return false;
        });
        this.log({ event: done ? 'published' : 'stale', atom: atom.id, tile: `${z}/${x}/${y}`,
            version });
    }

    // Where the bytes go, and where they already are: the file store's half
    // of a delivery (client/js/workstore.js).
    upload(atom, file, sha) {
        return putFile(this, atom, file, sha);
    }

    // Keeps claiming until stopped. An empty claim is not an error: it means
    // the world is compiled, so wait before asking again. A loop that stop()
    // then start() has superseded finishes its atom and exits.
    async start() {
        if (this.running) return;
        const generation = ++this.generation;
        const live = () => this.running && this.generation === generation;
        this.running = true;
        this.log({ event: 'start', caps: this.caps, lanes: this.lanes });
        await Promise.all(Array.from({ length: this.lanes }, () => this.lane(live)));
        this.log({ event: 'stop', done: this.done, failed: this.failed });
    }

    // One lane: atom after atom until the loop is stopped. `paced` is the
    // lane's own, so a tab being played holds each of them back on its own
    // account rather than all of them on one budget.
    async lane(live) {
        let paced = 0;
        while (live()) {
            let idle = false;
            const wait = this.pace();
            if (wait > 0 && paced < PACED_MAX_MS) {
                paced += wait;
                await new Promise((r) => this.timers.setTimeout(r, wait));
                continue;
            }
            paced = 0;
            try {
                idle = (await this.step()) === null;
            } catch { idle = true; }
            if (idle && live()) {
                await new Promise((r) => this.timers.setTimeout(r, IDLE_MS));
            }
        }
    }

    stop() { this.running = false; }

    // SPEC §3.12: a render somebody walked away from goes back into the pool.
    // The five-minute expiry (db/0005_state.sql) is the backstop for a tab
    // that crashed; a tab that is closing knows, and says so, so nobody waits
    // five minutes for work that is in nobody's hands.
    handBack() {
        const held = [...this.working.values()];
        if (!held.length) return false;
        this.running = false;
        this.working.clear();
        this.atom = null;
        for (const atom of held) {
            this.api.rpcOnTheWayOut?.('hand_back_atom', { atom_id: atom.id });
        }
        return held.length;
    }
}
