// workcaps.js — what this tab can do, and how it runs an atom.
//
// Split out of client/js/work.js, which is the loop: claim, fetch, run,
// upload, submit. These three are what the loop needs before it starts — the
// versions it builds, what claim_atom may hand it, and the Web Worker the
// atom itself runs in.

// The version of each op this tab builds. It is what claim_atom is told
// (`caps.algo`), so the world hands this tab only pieces it can make
// (db/0178). client/test/algo.test.js holds it to the atom modules and to the
// database's own algo_current(): the one time it drifted, every train piece
// in the world was claimed, refused and counted as a failed attempt.
export const ALGO = {
    dataset: 'dataset-v6', train: 'train-v20',
    merge: 'merge-v1', sog: 'sog-v3', verify: 'verify-v1',
};

function webglRenderer() {
    if (typeof document === 'undefined') return null;
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
}

// What claim_atom filters on: `webgpu` and `max_buffer_mb`
// (db/0083_thetrainerasksforwhatitcanbeasked.sql). This used to report a
// `vram_gb` guessed from the same limit, and the guess was always 1 or 2 —
// maxBufferSize is a cap the browser sets, not the card's memory — so an atom
// asking for 4 GB was unclaimable everywhere. The limit is reported as itself
// now, and the atom asks for the buffer it will actually allocate.
export async function probeCaps(over = {}) {
    const caps = { webgpu: false, max_buffer_mb: 0, algo: ALGO };
    const adapter = await globalThis.navigator?.gpu?.requestAdapter?.().catch(() => null);
    if (adapter) {
        const info = adapter.info ?? await adapter.requestAdapterInfo?.() ?? {};
        caps.webgpu = true;
        caps.adapter = {
            vendor: info.vendor ?? null, architecture: info.architecture ?? null,
            device: info.device ?? null, description: info.description ?? null,
        };
        caps.max_buffer_mb = Math.floor(
            Math.min(adapter.limits.maxBufferSize,
                adapter.limits.maxStorageBufferBindingSize) / 2 ** 20);
    } else {
        caps.renderer = webglRenderer();
    }
    return { ...caps, ...over };
}

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

// What a claim says this tab builds, given the atoms its lanes already hold.
// One dataset at a time: a z14's ground since db/0188 is a 2049-vertex mesh
// and its frames, about a gigabyte of the tab's memory, and four lanes each
// holding one ran the tab out of it. While one is held, the claim names a
// dataset version no atom has — leaving the op out would mean "any version"
// to claim_atom (db/0178 tab_builds) — and the other lanes take the rest.
export function capsFor(caps, near, held) {
    const busy = [...held].some((a) => a.op === 'dataset');
    return { ...caps, ...(near ? { near } : {}),
        ...(busy && caps.algo ? { algo: { ...caps.algo, dataset: 'held' } } : {}) };
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
