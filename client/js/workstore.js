// workstore.js — putting an atom's bytes into the file store, and finding them
// when they are already in it.
//
// Split out of client/js/work.js, which was over the four hundred lines
// CLAUDE.md allows. Invariant 1 is the whole of it: an artifact is written
// once, content-addressed, and never overwritten — so the interesting case
// here is not the upload but the refusal, which means the bytes exist
// somewhere else and this atom has to be told where.

import { ALGO } from './workcaps.js';

// Returns where the bytes are. 409 is this atom's own path already holding
// them — the same computation run twice. 403 is the artifact existing
// somewhere else in the store, which Invariant 1 forbids writing again.
export async function putFile(work, atom, file, sha) {
    const path = `${file.dir ?? `/jobs/${atom.id}`}/${sha}.${file.ext}`;
    const res = await work.fetchFn(work.filesUrl + path, {
        method: 'PUT',
        headers: {
            'X-Sha256': sha,
            Authorization: `Bearer ${work.api.token()}`,
            'Content-Type': 'application/octet-stream',
        },
        body: file.bytes,
    });
    if (res.status === 403) return elsewhere(work, sha, file.ext, path);
    if (res.status !== 201 && res.status !== 204 && res.status !== 409) {
        throw new Error(`PUT ${path} -> ${res.status}`);
    }
    await work.api.rpc('register_artifact', {
        sha256: sha, kind: file.kind, bytes: file.bytes.byteLength,
        algo_version: file.algo_version ?? ALGO[atom.op] ?? atom.algo_version,
    });
    work.log({ event: 'upload', atom: atom.id, sha, kind: file.kind,
        bytes: file.bytes.byteLength });
    return path;
}

async function elsewhere(work, sha, ext, wanted) {
    const [known] = await work.api.select('artifact',
        { sha256: `eq.${sha}`, select: 'sha256' });
    if (!known) throw new Error(`PUT ${wanted} -> 403`);
    const rows = await work.api.select('atom',
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
        const res = await work.fetchFn(work.filesUrl + path, { method: 'HEAD' });
        if (res.ok) {
            work.log({ event: 'deduped', sha, path });
            return path;
        }
    }
    throw new Error(`artifact ${sha} is registered but is nowhere in the store`);
}
