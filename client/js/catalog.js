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
import { nodeNames } from '../lib/canonmesh.js';
import { parseGlb } from '../lib/glb.js';
import { isMarked, partNodes } from '../lib/marks.js';
import { sha256 } from '../lib/hash.js';
import { renderThumb, ALGO as THUMB_ALGO } from '../lib/thumb.js';
import { canonCollection, canonProfile, describe } from '../lib/product.js';

const CATEGORIES = ['prop', 'building', 'vegetation', 'vehicle', 'furniture', 'other'];
const LICENSES = ['cc0', 'free', 'paid', 'limited'];

const FIELDS = 'san,name,category,license,price,editions,issued,tris,tex_bytes,'
    + 'bbox,sha256,thumb_sha256,canon_version,creator_id,created_at,type,parts,'
    + 'pointer,policy,term';

// LV.6: the model a product is sold under, said before Buy — db/0207
// policy_words, in the same words.
export function policyWords(asset) {
    if (asset?.policy === 'subscription') {
        return `Subscription: every update for as long as it is paid (${asset.term} at a`
            + ' time); after that, the last legacy version.';
    }
    if (asset?.policy === 'pinned') {
        return 'This exact version, for good: updates are not passed on.';
    }
    return 'Bought once: you keep this version, and receive fixes its maker marks as fixes.';
}

// What each of the five is, in the words the catalog uses for it (FND.5).
export const TYPES = [
    { id: 'model', words: 'Model' },
    { id: 'segment', words: 'Repeating piece' },
    { id: 'profile', words: 'Road cross-section' },
    { id: 'collection', words: 'Collection' },
    { id: 'material', words: 'Surface material' },
];

export const typeWords = (type) =>
    TYPES.find((t) => t.id === (type ?? 'model'))?.words ?? type;

export const thumbUrl = (asset) => (asset.thumb_sha256
    ? `${api.endpoints().files}/assets/${asset.thumb_sha256}.webp` : null);

export const glbUrl = (asset) => `${api.endpoints().files}/assets/${asset.sha256}.glb`;

// ------------------------------------------------------------------- search

// PostgREST does the filtering: a `search` matches the name, `category` and
// `license` are exact. Everything is a public read (db/0003_rls.sql).
export async function searchAssets({ search = '', category = '', license = '',
    type = '', limit = 60 } = {}) {
    const params = { select: FIELDS, order: 'created_at.desc', limit: String(limit) };
    if (search.trim()) params.name = `ilike.*${search.trim()}*`;
    if (category) params.category = `eq.${category}`;
    if (license) params.license = `eq.${license}`;
    if (type) params.type = `eq.${type}`;
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

// What the canon makes of a file, before anything is uploaded: the caller
// shows it, asks about near-duplicates, and only then commits. `marks` is the
// maker's markings (FND.6) — with any, the file is canon-v2 and the number is
// the database's to derive, because the same GLB marked differently is a
// different product (Invariant 6).
export async function prepare(bytes, { canvas, decodeDraco, marks = null } = {}) {
    const canon = await canonicalise(bytes,
        { decodeDraco, decodeImage, parts: partNodes(marks) });
    const thumb = canvas ? await renderThumb(canon.glb, canvas) : null;
    const near = await api.rpc('similar_assets',
        { name: '', tris: canon.meta.tris, bbox: canon.meta.bbox });
    // Any marking at all is part of what the product is, openings included —
    // and an opening changes no bytes, so only the database can tell the two
    // apart. It names both (db/0160).
    const san = isMarked(marks)
        ? await api.rpc('asset_name_for', { sha256: canon.sha256, parts: marks })
        : canon.san;
    return { ...canon, san, marks, nodes: nodeNames(parseGlb(bytes).json), thumb, near };
}

export async function duplicatesOf(name, canon) {
    return api.rpc('similar_assets',
        { name, tris: canon.meta.tris, bbox: canon.meta.bbox });
}

// Upload, register, catalogue — in that order, because register_asset will not
// name an artifact the store has never seen.
export async function publishAsset(canon, meta) {
    const { sha256: sha, san } = canon;
    const version = canon.canon_version ?? CANON_VERSION;
    let thumbSha = null;
    if (canon.thumb) {
        thumbSha = await sha256(canon.thumb);
        await store(canon.thumb, 'webp', thumbSha, 'thumb', THUMB_ALGO);
    }
    await store(canon.glb, 'glb', sha, 'glb', `canon-v${version}`);
    const registered = await api.rpc('register_asset', {
        sha256: sha, canon_version: version,
        meta: { ...meta, ...canon.meta, thumb_sha256: thumbSha,
            parts: isMarked(canon.marks) ? canon.marks : undefined },
    });
    if (registered !== san) {
        throw new Error(`the database derived ${registered}, canon-v${version} derived ${san}`);
    }
    return registered;
}

// ------------------------------------------------- the four that are not models

// A product whose file is not a GLB: the bytes, the kind of artifact they are,
// and the extension they are stored under. The rest of the path is a model's —
// store it, register it, catalogue it, in that order.
async function publishFile(bytes, ext, kind, algo, meta) {
    const sha = await sha256(bytes);
    await store(bytes, ext, sha, kind, algo);
    return api.rpc('register_asset',
        { sha256: sha, canon_version: 0, meta: { ...meta, type: meta.type } });
}

// A surface material: the PNG itself, and how many metres of ground one tile
// of it covers.
export const publishMaterial = (png, meta) =>
    publishFile(png, 'png', 'material', 'material-v1',
        { ...meta, type: 'material',
            parts: { tiling: Number(meta.tiling), px: Number(meta.px) } });

// A road's cross-section. There is no file to upload, so the description is
// the file: canonical JSON, named by its own sha256 (client/lib/product.js).
export async function publishProfile(profile, meta) {
    const canon = canonProfile(profile);
    return publishFile(describe(canon), 'json', 'profile', 'profile-v1',
        { ...meta, type: 'profile', profile: canon.strips,
            parts: { profile: canon } });
}

// A collection, the same way, and then the rows that say what is in it. The
// rows are a client write under RLS: only the maker may add to their own
// (db/0159).
export async function publishCollection(members, meta) {
    const canon = canonCollection(members);
    const san = await publishFile(describe(canon), 'json', 'collection',
        'collection-v1', { ...meta, type: 'collection', parts: { collection: canon } });
    await api.insert('collection_item', canon.members.map((m) => ({
        collection_san: san, member_san: m.san, weight: m.weight,
    })), { on_conflict: 'collection_san,member_san' });
    return san;
}

export const membersOf = (san) => api.select('collection_item', {
    collection_san: `eq.${san}`, select: 'member_san,weight', order: 'member_san.asc',
});

export { CATEGORIES, LICENSES };
