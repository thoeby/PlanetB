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
    select: 'id,area_id,name,elx_sha256,layout,rev,updated_at,instance_id',
    deleted_at: 'is.null', order: 'updated_at.desc',
});

export const flowsOn = (areaId) => api.select('flow', {
    select: 'id,area_id,name,elx_sha256,layout,rev,updated_at,instance_id',
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
//
// `instance` (FL.6, db/0194) says which thing the flow belongs to: a thing's
// id, or null for none. Left out, the thing it belongs to is left as it is.
export async function saveFlow({ id = null, areaId, name, elx = null, sha = null,
    layout = {}, rev = 0, instance }) {
    const at = elx === null ? sha : await storeElx(elx);
    if (!at) throw new Error('a flow is saved with its ELX or with its sha');
    const args = { id, area: areaId, name, elx_sha256: at, layout, rev };
    const done = await api.rpc('save_flow',
        instance === undefined ? args : { ...args, instance });
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
    instance: flow.instance_id ?? null,
});

// FL.6: the flow on this thing, or on none (null), with nothing else changed.
export const attachFlow = (flow, instance) => saveFlow({
    id: flow.id, areaId: flow.area_id, name: flow.name, sha: flow.elx_sha256,
    layout: flow.layout, rev: flow.rev, instance,
});

// The flows that belong to one thing, as far as this player may read them.
export const flowsOf = (instanceId) => api.select('flow', {
    select: 'id,area_id,name,elx_sha256,layout,rev,updated_at,instance_id',
    instance_id: `eq.${instanceId}`, deleted_at: 'is.null', order: 'name.asc',
});

// What things flows point at are called, gone ones included: a flow whose
// thing was taken away says what it was on (FL.6).
export async function thingNames(ids) {
    if (!ids.length) return new Map();
    const rows = await api.select('instance', { select: 'id,san,deleted_at',
        id: `in.(${ids.join(',')})` }).catch(() => []);
    const sans = [...new Set(rows.map((r) => r.san))];
    const assets = sans.length ? await api.select('asset',
        { select: 'san,name', san: `in.(${sans.join(',')})` }).catch(() => []) : [];
    const by = new Map(assets.map((a) => [a.san, a.name]));
    return new Map(rows.map((r) => [r.id,
        { name: by.get(r.san) ?? r.san, gone: Boolean(r.deleted_at) }]));
}

// ------------------------------------------------------------- what is there

// Everything placed on a land, with what its product can be told (FND.6,
// db/0160). A World block names an object by its id; this is how the inspector
// can offer it by name instead. Two lamps of the same product are told apart by
// a number, because that is all the world knows them by.
export async function objectsOn(areaId) {
    const rows = await api.select('instance', {
        select: 'id,san', area_id: `eq.${areaId}`, deleted_at: 'is.null',
        order: 'san.asc,id.asc', limit: '200',
    });
    if (!rows.length) return [];
    const sans = [...new Set(rows.map((r) => r.san))];
    const assets = await api.select('asset',
        { select: 'san,name,parts', san: `in.(${sans.join(',')})` });
    const by = new Map(assets.map((a) => [a.san, a]));
    const seen = new Map();
    return rows.map((r) => {
        const asset = by.get(r.san);
        const base = asset?.name ?? r.san;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        return { id: r.id, san: r.san, name: n === 1 ? base : `${base} ${n}`,
            ports: asset?.parts?.ports ?? [] };
    });
}

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
