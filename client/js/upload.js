// upload.js — where an atom's bytes go, and where they already are.
//
// Split from work.js. The store is written once (Invariant 1): a PUT lands
// the bytes under this atom's job directory, or is told they are already
// somewhere and has to find where.

// Returns where the bytes are. 409 is this atom's own path already holding
// them — the same computation run twice. 403 is the artifact existing
// somewhere else in the store, which Invariant 1 forbids writing again.
export async function upload(loop, atom, file, sha) {
    const path = `${file.dir ?? `/jobs/${atom.id}`}/${sha}.${file.ext}`;
    const res = await loop.fetchFn(loop.filesUrl + path, {
        method: 'PUT',
        headers: {
            'X-Sha256': sha,
            Authorization: `Bearer ${loop.api.token()}`,
            'Content-Type': 'application/octet-stream',
        },
        body: file.bytes,
    });
    if (res.status === 403) return elsewhere(loop, sha, file.ext, path);
    if (res.status !== 201 && res.status !== 204 && res.status !== 409) {
        throw new Error(`PUT ${path} -> ${res.status}`);
    }
    // Under the version the atom names: `compute` has already refused an
    // atom this tab's code does not build (Invariant 2). And where the bytes
    // went (db/0166): a later atom that makes the same bytes is refused them
    // and has to be told.
    await loop.api.rpc('register_artifact', {
        sha256: sha, kind: file.kind, bytes: file.bytes.byteLength,
        algo_version: file.algo_version ?? atom.algo_version, path,
    });
    loop.log({ event: 'upload', atom: atom.id, sha, kind: file.kind,
        bytes: file.bytes.byteLength });
    return path;
}

// The address the row carries (db/0166), then the path asked for — can_write
// refuses a registered sha before it looks at the path at all, so an atom
// that uploaded this file and then failed later is refused its own bytes
// back at the address they are already at — and last the atoms that made
// these bytes, for rows registered before the address was kept.
export async function elsewhere(loop, sha, ext, wanted) {
    const [known] = await loop.api.select('artifact',
        { sha256: `eq.${sha}`, select: 'sha256,path' });
    if (!known) throw new Error(`PUT ${wanted} -> 403`);
    const rows = await loop.api.select('atom',
        { output_sha256: `eq.${sha}`, select: 'id,result', order: 'id.asc', limit: '20' });
    const said = rows.find((r) => r.result?.path)?.result?.path;
    const tried = [];
    const guessed = rows.map((r) => `/jobs/${r.id}/${sha}.${ext}`);
    for (const path of [known.path, wanted, said, ...guessed]) {
        if (!path || tried.includes(path)) continue;
        tried.push(path);
        const res = await loop.fetchFn(loop.filesUrl + path, { method: 'HEAD' });
        if (res.ok) {
            loop.log({ event: 'deduped', sha, path });
            return path;
        }
    }
    // The database says the bytes exist and the store has them nowhere: the
    // store was emptied under a database that was not (tools/store-check.sh).
    throw new Error(`artifact ${sha} is registered but is nowhere in the store `
        + `(looked at ${tried.join(', ')})`);
}
