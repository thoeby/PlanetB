// flows.js — a land's flows: what there is, and how one is saved.
//
// SPEC §2.16. A flow is an ELX file and a pointer to it (db/0155). Saving is
// four steps, in this order and no other: serialize the graph to ELX, hash the
// bytes, PUT them into the file store at /assets/{sha}.elx, register them as an
// artifact of kind 'flow', and only then move the land's pointer. Nothing is
// overwritten on the way (Invariant 1) and nothing here decides who may do it
// — save_flow asks the policies (Invariant 6).

import * as api from './api.js';
import { sha256 } from '../lib/hash.js';

const PALETTE = '../flow/palette';

// Every flow on lands I build on or approve for, newest change first. The read
// is the policy's: somebody with nothing on a land gets nothing back.
export const listFlows = () => api.select('flow', {
    select: 'id,area_id,name,elx_sha256,layout,rev,updated_at',
    deleted_at: 'is.null', order: 'updated_at.desc',
});

export const flowsOn = (areaId) => api.select('flow', {
    select: 'id,area_id,name,elx_sha256,layout,rev,updated_at',
    area_id: `eq.${areaId}`, deleted_at: 'is.null', order: 'name.asc',
});

export const getFlow = (id) => api.select('flow', { id: `eq.${id}` })
    .then((rows) => rows[0] ?? null);

// The ELX itself, as text, straight out of the file store.
export async function elxOf(sha) {
    const res = await fetch(`${api.endpoints().files}/assets/${sha}.elx`);
    if (!res.ok) throw new Error(`the flow file is not there (${res.status})`);
    return res.text();
}

// --------------------------------------------------------------- the save

// The store answers three ways for bytes it may already hold (see catalog.js,
// which says the same thing about a GLB): 201 written, 409 that path is taken,
// 403 the sha is an artifact already. None of the three is a failure.
async function putElx(text, sha) {
    const path = `/assets/${sha}.elx`;
    const res = await fetch(api.endpoints().files + path, {
        method: 'PUT',
        headers: { 'X-Sha256': sha, Authorization: `Bearer ${api.token()}`,
            'Content-Type': 'application/xml' },
        body: text,
    });
    if (![201, 204, 403, 409].includes(res.status)) {
        throw new Error(`PUT ${path} -> ${res.status}`);
    }
    return res.status;
}

const registered = (sha) => api.select('artifact', { sha256: `eq.${sha}`, select: 'sha256' })
    .then((rows) => rows.length > 0);

// A file, stored and registered under the kind it is. Returns its sha256.
export async function storeFile(text, kind, algo) {
    const bytes = new TextEncoder().encode(text);
    const sha = await sha256(bytes);
    const status = await putElx(text, sha);
    if (status === 403 && !(await registered(sha))) {
        throw new Error(`PUT /assets/${sha}.elx -> 403`);
    }
    if (status !== 403) {
        await api.rpc('register_artifact',
            { sha256: sha, kind, bytes: bytes.byteLength, algo_version: algo });
    }
    return sha;
}

export const storeElx = (text) => storeFile(text, 'flow', 'elx-v1');

// Save a flow: either new bytes (`elx`) or the ones it already points at
// (`sha`, which is what renaming and duplicating do). `rev` is what this tab
// loaded; the database refuses a stale one rather than letting the later tab
// win silently.
export async function saveFlow({ id = null, areaId, name, elx = null, sha = null,
    layout = {}, rev = 0 }) {
    const at = elx === null ? sha : await storeElx(elx);
    if (!at) throw new Error('a flow is saved with its ELX or with its sha');
    const done = await api.rpc('save_flow',
        { id, area: areaId, name, elx_sha256: at, layout, rev });
    // The sha comes back with the id and the rev, because the caller's next
    // move — exporting exactly what was saved — is about the file, not the row.
    return { ...done, elx_sha256: at };
}

export const deleteFlow = (id, rev) => api.rpc('delete_flow', { id, rev });

// Renaming and duplicating are both a save of the bytes that are already
// there. Duplicate gets a fresh id, so the world holds two pointers to one
// immutable file rather than a second copy of it (Invariant 1).
export const renameFlow = (flow, name) => saveFlow({
    id: flow.id, areaId: flow.area_id, name, sha: flow.elx_sha256,
    layout: flow.layout, rev: flow.rev,
});

export const duplicateFlow = (flow, name) => saveFlow({
    areaId: flow.area_id, name, sha: flow.elx_sha256, layout: flow.layout, rev: 0,
});

// --------------------------------------------------------------- the palette

// What there is to draw with. The bundled set is static files under
// client/flow/palette (manifest.json lists them, because a directory cannot be
// listed over HTTP); a process server's own set arrives in FND.2.
export async function bundledPlugins() {
    const url = new URL(`${PALETTE}/manifest.json`, import.meta.url);
    const manifest = await fetch(url).then((r) => r.json());
    const out = [];
    for (const p of manifest.plugins) {
        const xml = await fetch(new URL(`${PALETTE}/${p.xml}`, import.meta.url))
            .then((r) => r.text());
        out.push({ id: p.id, xml });
    }
    return out;
}

// Setup says which plugin set the world saw, so a flow drawn against one can be
// read later against another (db/0155 elx_plugin). Admin only, and the XMLs are
// stored the same way the ELX is.
export async function bundlePlugins(plugins) {
    const rows = [];
    for (const p of plugins) {
        const sha = await storeFile(p.xml, 'plugin', 'plugin-v1');
        rows.push({ id: p.id, name: p.id, xml_sha256: sha });
    }
    return api.rpc('bundle_plugins', { plugins: rows });
}
