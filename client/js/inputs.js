// inputs.js — turning an atom's `inputs` into bytes.
//
// build_dag (db/0005_jobs.sql) names an input three ways, and each is resolved
// differently:
//
//   a number      another atom in the same job; its output lives at
//                 /jobs/{atom}/{output_sha256}
//   64 hex chars  an artifact somewhere in the store; where depends on its kind
//   anything else not an artifact at all — a world snapshot hash, a seed name —
//                 and is handed to the atom as it stands
//
// Invariant 2: an atom's inputs are fixed when the job is built, so every byte
// here is immutable and cacheable for ever. The Cache API keeps them across
// atoms and across tabs, keyed by the URL, which carries the hash.

const SHA = /^[0-9a-f]{64}$/;

// Every atom id and artifact sha the atom names, deduplicated, so the whole
// resolution costs two requests however many inputs there are.
function refsOf(inputs) {
    const atoms = new Set(), shas = new Set();
    for (const value of Object.values(inputs ?? {})) {
        for (const v of Array.isArray(value) ? value : [value]) {
            if (typeof v === 'number') atoms.add(v);
            else if (typeof v === 'string' && SHA.test(v)) shas.add(v);
        }
    }
    return { atoms: [...atoms], shas: [...shas] };
}

const inList = (xs) => `in.(${xs.join(',')})`;

async function locate(api, refs) {
    const at = new Map(), art = new Map();
    if (refs.atoms.length) {
        for (const a of await api.select('atom',
            { id: inList(refs.atoms), select: 'id,output_sha256,result' })) {
            // Where the producer put them, if it said; otherwise where the
            // claim reserved room for them.
            if (a.output_sha256) at.set(a.id, a.result?.path ?? `/jobs/${a.id}/${a.output_sha256}`);
        }
    }
    if (refs.shas.length) {
        const rows = await api.select('artifact',
            { sha256: inList(refs.shas), select: 'sha256,kind' });
        const sogs = rows.filter((r) => r.kind === 'sog').map((r) => r.sha256);
        const tiles = sogs.length
            ? await api.select('tile',
                { sog_sha256: inList(sogs), select: 'z,x,y,sog_sha256' })
            : [];
        const byTile = new Map(tiles.map((t) => [t.sog_sha256, t]));
        // A sog no tile publishes any more is still where its atom put it.
        const stale = sogs.filter((sha) => !byTile.has(sha));
        const said = stale.length
            ? await api.select('atom',
                { output_sha256: inList(stale), op: 'eq.sog', select: 'output_sha256,result' })
            : [];
        for (const a of said) if (a.result?.path) byTile.set(a.output_sha256, a.result);
        for (const r of rows) art.set(r.sha256, path(r, byTile.get(r.sha256)));
    }
    return { at, art };
}

// The store has one place for each kind of artifact (ARCHITECTURE §7). A tile's
// .sog is found through the tile that publishes it; nothing else needs a lookup.
function path(artifact, tile) {
    const { sha256: sha, kind } = artifact;
    if (kind === 'sog') {
        if (!tile) throw new Error(`no published tile or atom holds sog ${sha}`);
        return tile.path ?? `/tiles/${tile.z}/${tile.x}/${tile.y}/${sha}.sog`;
    }
    if (kind === 'glb') return `/assets/${sha}.glb`;
    if (kind === 'thumb') return `/assets/${sha}.webp`;
    throw new Error(`artifact ${sha} of kind ${kind} has no addressable path`);
}

// { key: url | url[] | value } — the shape atoms are handed, with every
// artifact reference replaced by where its bytes are.
export async function resolveInputs(api, inputs) {
    const { at, art } = await locate(api, refsOf(inputs));
    const one = (v) => {
        if (typeof v === 'number') {
            const u = at.get(v);
            if (!u) throw new Error(`atom ${v} has produced no output yet`);
            return u;
        }
        if (typeof v === 'string' && SHA.test(v)) return art.get(v) ?? null;
        return v;
    };
    const out = {};
    for (const [k, v] of Object.entries(inputs ?? {})) {
        out[k] = Array.isArray(v) ? v.map(one) : one(v);
    }
    return out;
}

// The bytes behind those URLs, fetched once and kept. `caches` is missing
// outside a secure context and in node; an in-memory map is the fallback, which
// is correct but forgets everything when the tab closes.
export class InputCache {
    // Bare `fetch` unbinds itself from the window; it has to be called through
    // something that keeps its receiver.
    constructor({ filesUrl, name = 'splatworld-inputs', fetchFn } = {}) {
        this.filesUrl = filesUrl ?? '';
        this.name = name;
        this.fetchFn = fetchFn ?? ((...a) => fetch(...a));
        this.memory = new Map();
    }

    async store() {
        if (this.opened !== undefined) return this.opened;
        this.opened = globalThis.caches ? await globalThis.caches.open(this.name) : null;
        return this.opened;
    }

    async bytes(path) {
        const url = path.startsWith('http') ? path : this.filesUrl + path;
        const store = await this.store();
        if (!store) {
            if (!this.memory.has(url)) {
                this.memory.set(url, await this.fetchOne(url));
            }
            return this.memory.get(url);
        }
        const hit = await store.match(url);
        if (hit) return hit.arrayBuffer();
        const res = await this.fetchFn(url);
        if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
        await store.put(url, res.clone());
        return res.arrayBuffer();
    }

    async fetchOne(url) {
        const res = await this.fetchFn(url);
        if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
        return res.arrayBuffer();
    }

    // The same shape as the resolved inputs, with every URL replaced by bytes.
    async load(resolved) {
        const out = {};
        for (const [k, v] of Object.entries(resolved)) {
            const get = async (u) => (typeof u === 'string' && u.startsWith('/')
                ? this.bytes(u) : u);
            out[k] = Array.isArray(v) ? await Promise.all(v.map(get)) : await get(v);
        }
        return out;
    }
}
