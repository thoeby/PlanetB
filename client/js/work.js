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

export const ALGO = {
    assemble: 'assemble-v1', frame: 'frame-v1', train: 'train-v1',
    sample: 'sample-v1', merge: 'merge-v1', sog: 'sog-v1', verify: 'verify-v1',
};

const HEARTBEAT_MS = 60_000;
const IDLE_MS = 15_000;
// How long the pace may hold the loop back before it takes an atom anyway.
// Standing aside for a tab that is being played is the point (WP5.2); standing
// aside for ever is not. A machine that never reaches 30 fps — a software
// renderer, an old laptop — would otherwise offer to help the world and then
// never claim anything, which is the same as not offering.
const PACED_MAX_MS = 10_000;

// ------------------------------------------------------------------ capability

function webglRenderer() {
    if (typeof document === 'undefined') return null;
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
}

// What claim_atom filters on: `webgpu` and `vram_gb` (db/0005_state.sql). VRAM
// is not something WebGPU reports, so the largest buffer the adapter will hand
// out stands in for it — an estimate, and named one.
export async function probeCaps(over = {}) {
    const caps = { webgpu: false, vram_gb: 0, algo: ALGO };
    const adapter = await globalThis.navigator?.gpu?.requestAdapter?.().catch(() => null);
    if (adapter) {
        const info = adapter.info ?? await adapter.requestAdapterInfo?.() ?? {};
        caps.webgpu = true;
        caps.adapter = {
            vendor: info.vendor ?? null, architecture: info.architecture ?? null,
            device: info.device ?? null, description: info.description ?? null,
        };
        caps.vram_gb = Math.max(1, Math.round(adapter.limits.maxBufferSize / 2 ** 30));
        caps.vram_estimated = true;
    } else {
        caps.renderer = webglRenderer();
    }
    return { ...caps, ...over };
}

// ---------------------------------------------------------------- the worker

export function spawnAtomWorker() {
    const w = new globalThis.Worker(new URL('./atomworker.js', import.meta.url),
        { type: 'module' });
    return {
        run: (msg, onLog) => new Promise((resolve, reject) => {
            w.onmessage = (ev) => {
                if (ev.data?.log) return onLog(ev.data.log);
                if (ev.data?.error) {
                    const err = new Error(ev.data.error);
                    err.where = ev.data.where ?? '';
                    return reject(err);
                }
                return resolve(ev.data?.done);
            };
            w.onerror = (e) => reject(new Error(e.message ?? 'atom worker failed'));
            w.postMessage(msg);
        }),
        terminate: () => w.terminate(),
    };
}

// -------------------------------------------------------------------- the loop

export class WorkLoop {
    // `pace` is asked before every claim: it answers how long to wait before
    // starting the next atom, in milliseconds, and 0 for "go now". WP5.2 uses
    // it to keep a tab that is also being played above 30 fps; a worker tab
    // that is not rendering anything passes nothing and never waits.
    // `where` answers the player's position, which claim_atom orders by.
    constructor({ api, apiUrl, filesUrl, caps = {}, spawn = spawnAtomWorker, cache,
        log = () => {}, timers = globalThis, fetchFn, pace, where } = {}) {
        this.pace = pace ?? (() => 0);
        this.where = where ?? (() => null);
        this.api = api;
        this.apiUrl = apiUrl ?? '';
        this.filesUrl = filesUrl ?? '';
        this.caps = caps;
        this.spawn = spawn;
        this.cache = cache ?? new InputCache({ filesUrl, fetchFn });
        this.fetchFn = fetchFn ?? ((...a) => fetch(...a));
        this.log = (rec) => {
            const full = { t: Date.now(), ...rec };
            console.debug(JSON.stringify(full));
            log(full);
        };
        this.timers = timers;
        this.running = false;
        this.generation = 0;
        this.claimFailures = 0;
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
        this.atom = atom;
        this.log({ event: 'claim', atom: atom.id, op: atom.op, job: atom.job_id });
        // A long atom saturates the machine, and a starved main thread is one
        // whose interval callbacks do not run: expire_claims would take the
        // atom away from a worker that is still doing it. So the atom's own
        // progress reports beat as well as the timer.
        let last = Date.now();
        const beat = () => {
            last = Date.now();
            this.api.rpc('heartbeat', { atom_id: atom.id }).catch(
                (err) => this.log({ event: 'beat-failed', atom: atom.id, err: String(err) }));
        };
        const timer = this.timers.setInterval(beat, HEARTBEAT_MS);
        const progress = () => { if (Date.now() - last > HEARTBEAT_MS / 2) beat(); };
        try {
            const started = Date.now();
            const out = await this.compute(atom, progress);
            const state = await this.deliver(atom, out, (Date.now() - started) / 1000);
            this[state === 'failed' ? 'failed' : 'done'] += 1;
            this.log({ event: 'submit', atom: atom.id, op: atom.op, state });
            return state;
        } catch (err) {
            this.failed += 1;
            // The message, not the stack: the panel is one line per event, and
            // the stack is the atom worker's, not this one's.
            // Whole, with its lines run together: a message that says what
            // each of three attempts complained about is useless cut at the
            // first newline, which is where its summary line ends.
            this.log({ event: 'error', atom: atom.id, op: atom.op,
                err: String(err?.message ?? err).replace(/\s*\n\s*/g, ' · ').slice(0, 600),
                ...(err?.where ? { where: err.where } : {}) });
            throw err;
        } finally {
            this.timers.clearInterval(timer);
            this.atom = null;
        }
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

    async compute(atom, progress = () => {}) {
        const resolved = await resolveInputs(this.api, atom.inputs);
        const inputs = await this.cache.load(resolved);
        const worker = this.spawn();
        try {
            const out = await worker.run(
                { atom, inputs, apiUrl: this.apiUrl, filesUrl: this.filesUrl },
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
    async deliver(atom, out, seconds) {
        const written = [];
        for (const file of out.files ?? []) {
            const sha = await sha256(file.bytes);
            written.push({ sha, ext: file.ext, path: await this.upload(atom, file, sha) });
        }
        const pick = written.find((w) => w.ext === out.output) ?? written[0] ?? null;
        // Where the bytes went travels with the atom: an artifact is written
        // once, so a later atom that produces the same bytes cannot put them
        // under its own job directory, and its consumer has to be told where
        // they really are (client/js/inputs.js).
        const result = { gpu_seconds: seconds, ...out.result,
            path: pick?.path ?? null, files: written };
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

    // Returns where the bytes are. 409 is this atom's own path already holding
    // them — the same computation run twice. 403 is the artifact existing
    // somewhere else in the store, which Invariant 1 forbids writing again.
    async upload(atom, file, sha) {
        const path = `${file.dir ?? `/jobs/${atom.id}`}/${sha}.${file.ext}`;
        const res = await this.fetchFn(this.filesUrl + path, {
            method: 'PUT',
            headers: {
                'X-Sha256': sha,
                Authorization: `Bearer ${this.api.token()}`,
                'Content-Type': 'application/octet-stream',
            },
            body: file.bytes,
        });
        if (res.status === 403) return this.elsewhere(sha, file.ext, path);
        if (res.status !== 201 && res.status !== 204 && res.status !== 409) {
            throw new Error(`PUT ${path} -> ${res.status}`);
        }
        await this.api.rpc('register_artifact', {
            sha256: sha, kind: file.kind, bytes: file.bytes.byteLength,
            algo_version: file.algo_version ?? ALGO[atom.op] ?? atom.algo_version,
        });
        this.log({ event: 'upload', atom: atom.id, sha, kind: file.kind,
            bytes: file.bytes.byteLength });
        return path;
    }

    async elsewhere(sha, ext, wanted) {
        const [known] = await this.api.select('artifact',
            { sha256: `eq.${sha}`, select: 'sha256' });
        if (!known) throw new Error(`PUT ${wanted} -> 403`);
        const rows = await this.api.select('atom',
            { output_sha256: `eq.${sha}`, select: 'id,result', order: 'id.asc', limit: '20' });
        const said = rows.find((r) => r.result?.path)?.result?.path;
        // The path asked for, first. can_write refuses a registered sha before
        // it looks at the path at all (Invariant 1), so an atom that uploaded
        // this file and then failed later is refused its own bytes back at the
        // address they are already at. A tile's height and colliders are that
        // case: they belong to no atom's output_sha256, so nothing below finds
        // them.
        for (const path of [wanted, said, ...rows.map((r) => `/jobs/${r.id}/${sha}.${ext}`)]) {
            if (!path) continue;
            const res = await this.fetchFn(this.filesUrl + path, { method: 'HEAD' });
            if (res.ok) {
                this.log({ event: 'deduped', sha, path });
                return path;
            }
        }
        throw new Error(`artifact ${sha} is registered but is nowhere in the store`);
    }

    // Keeps claiming until stopped. An empty claim is not an error: it means
    // the world is compiled, so wait before asking again. A loop that stop()
    // then start() has superseded finishes its atom and exits.
    async start() {
        if (this.running) return;
        const generation = ++this.generation;
        const live = () => this.running && this.generation === generation;
        this.running = true;
        this.log({ event: 'start', caps: this.caps });
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
        this.log({ event: 'stop', done: this.done, failed: this.failed });
    }

    stop() { this.running = false; }
}
