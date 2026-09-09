// catalog.js — the asset catalog: search it, look at one, add one.
//
// Uploading is entirely the tab's work (Invariant 9): canon-v1 normalises the
// GLB here, a thumbnail is rendered here, both are PUT to nginx, and only then
// does register_asset turn them into a catalog entry. The SAN comes back from
// the database, derived from the bytes — the uploader never names their asset.
//
// Nothing in this file decides who may upload. can_write and row-level security
// do (Invariant 6); a 401 or 403 is that decision arriving.

import * as api from './api.js';
import { CANON_VERSION, canonicalise } from '../lib/canon.js';
import { sha256 } from '../lib/hash.js';
import { renderThumb, ALGO as THUMB_ALGO } from '../lib/thumb.js';

const CATEGORIES = ['prop', 'building', 'vegetation', 'vehicle', 'furniture', 'other'];
const LICENSES = ['cc0', 'free', 'paid', 'limited'];

const FIELDS = 'san,name,category,license,price,editions,issued,tris,tex_bytes,'
    + 'bbox,sha256,thumb_sha256,canon_version,creator_id,created_at';

export const thumbUrl = (asset) => (asset.thumb_sha256
    ? `${api.endpoints().files}/assets/${asset.thumb_sha256}.webp` : null);

export const glbUrl = (asset) => `${api.endpoints().files}/assets/${asset.sha256}.glb`;

// ------------------------------------------------------------------- search

// PostgREST does the filtering: a `search` matches the name, `category` and
// `license` are exact. Everything is a public read (db/0003_rls.sql).
export async function searchAssets({ search = '', category = '', license = '',
    limit = 60 } = {}) {
    const params = { select: FIELDS, order: 'created_at.desc', limit: String(limit) };
    if (search.trim()) params.name = `ilike.*${search.trim()}*`;
    if (category) params.category = `eq.${category}`;
    if (license) params.license = `eq.${license}`;
    return api.select('asset', params);
}

export const getAsset = (san) =>
    api.select('asset', { select: FIELDS, san: `eq.${san}` }).then((rows) => rows[0] ?? null);

// --------------------------------------------------------------------- upload

// An artifact is written once (Invariant 1), so the store answers three ways:
// 201 for bytes it did not have, 409 for a path it already holds, and 403 from
// can_write when the sha is already an artifact. Only the last means there is
// nothing left to do.
async function putAsset(bytes, ext, sha) {
    const path = `/assets/${sha}.${ext}`;
    const res = await fetch(api.endpoints().files + path, {
        method: 'PUT',
        headers: { 'X-Sha256': sha, Authorization: `Bearer ${api.token()}`,
            'Content-Type': 'application/octet-stream' },
        body: bytes,
    });
    if (![201, 204, 403, 409].includes(res.status)) {
        throw new Error(`PUT ${path} -> ${res.status}`);
    }
    return res.status;
}

const registered = (sha) => api.select('artifact', { sha256: `eq.${sha}`, select: 'sha256' })
    .then((rows) => rows.length > 0);

// A 409 is the store outliving the database: the bytes are at that path from an
// earlier run and `artifact` no longer knows them, so they still have to be
// registered. A 403 is either the artifact already existing — nothing to do —
// or a real refusal, and the two are told apart by asking.
async function store(bytes, ext, sha, kind, algo) {
    const status = await putAsset(bytes, ext, sha);
    if (status === 403) {
        if (await registered(sha)) return sha;
        throw new Error(`PUT /assets/${sha}.${ext} -> 403`);
    }
    await api.rpc('register_artifact',
        { sha256: sha, kind, bytes: bytes.byteLength, algo_version: algo });
    return sha;
}

// canon-v1 decodes PNG itself; a JPEG or WebP texture over 2048 px needs the
// platform's decoder, which a browser has and node does not. A 2D canvas stores
// colour premultiplied by alpha (WP2's deviation 38), so a transparent texture
// loses some colour on the way through — it is only ever shrunk, never kept.
async function decodeImage(bytes, info) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: info.mime }));
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = surface.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, data };
}

// What canon-v1 makes of a file, before anything is uploaded: the caller shows
// it, asks about near-duplicates, and only then commits.
export async function prepare(bytes, { canvas, decodeDraco } = {}) {
    const canon = await canonicalise(bytes, { decodeDraco, decodeImage });
    const thumb = canvas ? await renderThumb(canon.glb, canvas) : null;
    const near = await api.rpc('similar_assets',
        { name: '', tris: canon.meta.tris, bbox: canon.meta.bbox });
    return { ...canon, thumb, near };
}

export async function duplicatesOf(name, canon) {
    return api.rpc('similar_assets',
        { name, tris: canon.meta.tris, bbox: canon.meta.bbox });
}

// Upload, register, catalogue — in that order, because register_asset will not
// name an artifact the store has never seen.
export async function publishAsset(canon, meta) {
    const { sha256: sha, san } = canon;
    let thumbSha = null;
    if (canon.thumb) {
        thumbSha = await sha256(canon.thumb);
        await store(canon.thumb, 'webp', thumbSha, 'thumb', THUMB_ALGO);
    }
    await store(canon.glb, 'glb', sha, 'glb', `canon-v${CANON_VERSION}`);
    const registered = await api.rpc('register_asset', {
        sha256: sha, canon_version: CANON_VERSION,
        meta: { ...meta, ...canon.meta, thumb_sha256: thumbSha },
    });
    if (registered !== san) {
        throw new Error(`the database derived ${registered}, canon-v1 derived ${san}`);
    }
    return registered;
}

export { CATEGORIES, LICENSES };
