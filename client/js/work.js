// work.js — what a tab does when it decides to help compile the world.
//
// Claim an atom, fetch its inputs, run it in a Web Worker, upload what it made,
// register it, submit it. The server decides everything: claim_atom hands out
// the work, can_write authorises the upload, submit_atom runs the structural
// checks. Nothing here is trusted (Invariant 9), and nothing here computes on
// the server's behalf — this is the compute.
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
    merge: 'merge-v1', sog: 'sog-v1', verify: 'verify-v1',
};

const HEARTBEAT_MS = 60_000;
const IDLE_MS = 15_000;

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
                if (ev.data?.error) return reject(new Error(ev.data.error));
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
    constructor({ api, apiUrl, filesUrl, caps = {}, spawn = spawnAtomWorker, cache,
        log = () => {}, timers = globalThis, fetchFn } = {}) {
        this.api = api;
        this.apiUrl = apiUrl ?? '';
        this.filesUrl = filesUrl ?? '';
        this.caps = caps;
        this.spawn = spawn;
        this.cache = cache ?? new InputCache({ filesUrl, fetchFn });
        this.fetchFn = fetchFn ?? ((...a) => fetch(...a));
        this.log = (rec) => log({ t: Date.now(), ...rec });
        this.timers = timers;
        this.running = false;
        this.atom = null;
        this.done = 0;
        this.failed = 0;
    }

    // One atom, start to finish. Returns the state submit_atom settled on, or
    // null when there was nothing to claim.
    async step() {
        const atom = await this.api.rpc('claim_atom', { caps: this.caps });
        if (!atom?.id) return null;
        this.atom = atom;
        this.log({ event: 'claim', atom: atom.id, op: atom.op, job: atom.job_id });
        const beat = this.timers.setInterval(
            () => this.api.rpc('heartbeat', { atom_id: atom.id }).catch(
                (err) => this.log({ event: 'beat-failed', atom: atom.id, err: String(err) })),
            HEARTBEAT_MS);
        try {
            const started = Date.now();
            const out = await this.compute(atom);
            const state = await this.deliver(atom, out, (Date.now() - started) / 1000);
            this[state === 'failed' ? 'failed' : 'done'] += 1;
            this.log({ event: 'submit', atom: atom.id, op: atom.op, state });
            return state;
        } catch (err) {
            this.failed += 1;
            this.log({ event: 'error', atom: atom.id, op: atom.op,
                err: String(err?.message ?? err) });
            throw err;
        } finally {
            this.timers.clearInterval(beat);
            this.atom = null;
        }
    }

    async compute(atom) {
        const resolved = await resolveInputs(this.api, atom.inputs);
        const inputs = await this.cache.load(resolved);
        const worker = this.spawn();
        try {
            const out = await worker.run(
                { atom, inputs, apiUrl: this.apiUrl, filesUrl: this.filesUrl },
                (rec) => this.log({ atom: atom.id, ...rec }));
            if (!out?.files?.length) throw new Error(`${atom.op} produced no files`);
            return out;
        } finally {
            worker.terminate();
        }
    }

    // Upload, register, submit — in that order, because register_artifact is
    // what makes an upload citable and submit_atom reads the artifact's size.
    async deliver(atom, out, seconds) {
        const written = [];
        for (const file of out.files) {
            const sha = await sha256(file.bytes);
            written.push({ sha, ext: file.ext, path: await this.upload(atom, file, sha) });
        }
        const pick = written.find((w) => w.ext === out.output) ?? written[0];
        // Where the bytes went travels with the atom: an artifact is written
        // once, so a later atom that produces the same bytes cannot put them
        // under its own job directory, and its consumer has to be told where
        // they really are (client/js/inputs.js).
        const result = { gpu_seconds: seconds, ...out.result,
            path: pick.path, files: written };
        return this.api.rpc('submit_atom',
            { atom_id: atom.id, output_sha256: pick.sha, result });
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
        // An atom that ran before paths were recorded still put its output
        // where its claim reserved room for it; ask the store.
        for (const path of [said, ...rows.map((r) => `/jobs/${r.id}/${sha}.${ext}`)]) {
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
    // the world is compiled, so wait before asking again.
    async start() {
        if (this.running) return;
        this.running = true;
        this.log({ event: 'start', caps: this.caps });
        while (this.running) {
            let idle = false;
            try {
                idle = (await this.step()) === null;
            } catch { idle = true; }
            if (idle && this.running) {
                await new Promise((r) => this.timers.setTimeout(r, IDLE_MS));
            }
        }
        this.log({ event: 'stop', done: this.done, failed: this.failed });
    }

    stop() { this.running = false; }
}
