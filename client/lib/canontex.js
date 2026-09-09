// canontex.js — the material half of canon-v1: images, samplers, textures and
// materials, reduced to a normal form and sorted so their indices carry no
// history.
//
// Everything an exporter puts in for a human — names, extras, the extensions
// this world does not understand — is dropped. What is left is what a renderer
// would actually use, with the spec's defaults removed rather than written out,
// because two tools disagree about which defaults to write.

import { sortKeys, viewBytes } from './glb.js';
import { boxResize, decodePng, encodePng, imageInfo } from './png.js';

export const MAX_TEXTURE = 2048;
const KEEP = /^KHR_materials_/;

const stable = (v) => JSON.stringify(sortKeys(v));

// A byte-for-byte identical image is one image, however many times the file
// carried it. Sorting by the bytes themselves makes the order the file's own.
function dedupe(items, keyOf) {
    const remap = new Uint32Array(items.length);
    const order = items.map((item, i) => ({ key: keyOf(item), item, i }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const list = [];
    const seen = new Map();
    for (const { key, item, i } of order) {
        if (!seen.has(key)) { seen.set(key, list.length); list.push(item); }
        remap[i] = seen.get(key);
    }
    return { list, remap };
}

// ---------------------------------------------------------------------- images

const DATA_URI = /^data:([^;,]*)?(?:;base64)?,/;

function imageBytes(gltf, buffers, image) {
    if (image.bufferView !== undefined) return viewBytes(gltf, buffers, image.bufferView);
    if (typeof image.uri === 'string' && DATA_URI.test(image.uri)) {
        return Uint8Array.from(atob(image.uri.slice(image.uri.indexOf(',') + 1)),
            (c) => c.charCodeAt(0));
    }
    throw new Error('external image files are not supported by canon-v1');
}

// Only an oversized texture is re-encoded, and then as PNG, which this repo
// writes itself. A texture already within budget keeps its exact bytes: an
// asset whose textures differ is a different asset, and should hash as one.
async function fit(bytes, decodeImage) {
    const info = imageInfo(bytes);
    if (Math.max(info.width, info.height) <= MAX_TEXTURE) return { mime: info.mime, bytes };
    const scale = MAX_TEXTURE / Math.max(info.width, info.height);
    const w = Math.max(1, Math.round(info.width * scale));
    const h = Math.max(1, Math.round(info.height * scale));
    const src = info.mime === 'image/png' ? await decodePng(bytes)
        : await decodeOther(bytes, info, decodeImage);
    return { mime: 'image/png',
        bytes: encodePng(boxResize(src.data, src.width, src.height, w, h), w, h) };
}

async function decodeOther(bytes, info, decodeImage) {
    if (!decodeImage) {
        throw new Error(`a ${info.width}x${info.height} ${info.mime} needs a decoder to resize`);
    }
    return decodeImage(bytes, info);
}

const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function canonImages(gltf, buffers, decodeImage) {
    const raw = [];
    for (const image of gltf.images ?? []) {
        raw.push(await fit(imageBytes(gltf, buffers, image), decodeImage));
    }
    return dedupe(raw,
        (img) => `${String(img.bytes.length).padStart(12, '0')}:${hexOf(img.bytes)}`);
}

// -------------------------------------------------------- samplers + textures

const REPEAT = 10497;

// Only the wrap modes survive: they change which pixel a UV outside 0..1 reads,
// so they are part of the asset. magFilter and minFilter are a preference about
// how to sample it — exporters set them differently for the same model, and the
// renderer this world ships picks its own anyway.
function canonSampler(sampler) {
    const out = {};
    for (const k of ['wrapS', 'wrapT']) {
        if (sampler[k] !== undefined && sampler[k] !== REPEAT) out[k] = sampler[k];
    }
    return out;
}

export function canonTextures(gltf, images) {
    const samplers = dedupe((gltf.samplers ?? []).map(canonSampler), stable);
    const textures = (gltf.textures ?? []).map((t) => {
        const out = {};
        if (t.source !== undefined) out.source = images.remap[t.source];
        if (t.sampler !== undefined) out.sampler = samplers.remap[t.sampler];
        return out;
    });
    return { samplers: samplers.list, ...dedupe(textures, stable) };
}

// -------------------------------------------------------------------- materials

const TEXTURE_SLOTS = ['baseColorTexture', 'metallicRoughnessTexture',
    'normalTexture', 'occlusionTexture', 'emissiveTexture'];

function canonTextureRef(ref, remap) {
    const out = { index: remap[ref.index] };
    if (ref.texCoord) out.texCoord = ref.texCoord;
    if (ref.scale !== undefined && ref.scale !== 1) out.scale = ref.scale;
    if (ref.strength !== undefined && ref.strength !== 1) out.strength = ref.strength;
    return out;
}

function canonPbr(pbr, remap) {
    const out = {};
    const factor = pbr.baseColorFactor;
    if (factor && factor.some((v) => v !== 1)) out.baseColorFactor = factor.map(round4);
    for (const k of ['metallicFactor', 'roughnessFactor']) {
        if (pbr[k] !== undefined && pbr[k] !== 1) out[k] = round4(pbr[k]);
    }
    for (const k of ['baseColorTexture', 'metallicRoughnessTexture']) {
        if (pbr[k]) out[k] = canonTextureRef(pbr[k], remap);
    }
    return out;
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;

// Invariant 2 in the small: the same material description always produces the
// same bytes, so an atom that names this asset names exactly these pixels.
export function canonMaterial(material, remap) {
    const out = {};
    const pbr = canonPbr(material.pbrMetallicRoughness ?? {}, remap);
    if (Object.keys(pbr).length) out.pbrMetallicRoughness = pbr;
    for (const k of TEXTURE_SLOTS.slice(2)) {
        if (material[k]) out[k] = canonTextureRef(material[k], remap);
    }
    if (material.emissiveFactor?.some((v) => v !== 0)) {
        out.emissiveFactor = material.emissiveFactor.map(round4);
    }
    if (material.alphaMode && material.alphaMode !== 'OPAQUE') out.alphaMode = material.alphaMode;
    if (material.alphaMode === 'MASK' && material.alphaCutoff !== undefined
        && material.alphaCutoff !== 0.5) out.alphaCutoff = round4(material.alphaCutoff);
    if (material.doubleSided) out.doubleSided = true;
    const ext = {};
    for (const [name, value] of Object.entries(material.extensions ?? {})) {
        if (KEEP.test(name)) ext[name] = value;
    }
    if (Object.keys(ext).length) out.extensions = ext;
    return out;
}

export function canonMaterials(gltf, textures) {
    const list = (gltf.materials ?? []).map((m) => canonMaterial(m, textures.remap));
    list.push({});                                  // the default a primitive with no material gets
    return dedupe(list, stable);
}

export const usesTexture = (material) =>
    TEXTURE_SLOTS.some((slot) => material[slot] || material.pbrMetallicRoughness?.[slot]);

export const extensionsOf = (materials) => [...new Set(materials
    .flatMap((m) => Object.keys(m.extensions ?? {})))].sort();

// --------------------------------------------------------------------- prune

// A texture no surviving material samples is not part of the asset, and an
// image no texture names is not either. Dropping them keeps `tex_bytes` honest
// and stops an unused leftover from changing the SAN of the same model.
export function prune(materials, textures, images) {
    const texUsed = collect(materials, (m, take) => {
        for (const slot of TEXTURE_SLOTS) {
            const ref = m[slot] ?? m.pbrMetallicRoughness?.[slot];
            if (ref) take(ref.index);
        }
    });
    const kept = texUsed.order.map((i) => ({ ...textures.list[i] }));
    const imgUsed = collect(kept, (t, take) => { if (t.source !== undefined) take(t.source); });
    const smpUsed = collect(kept, (t, take) => { if (t.sampler !== undefined) take(t.sampler); });
    for (const t of kept) {
        if (t.source !== undefined) t.source = imgUsed.index.get(t.source);
        if (t.sampler !== undefined) t.sampler = smpUsed.index.get(t.sampler);
    }
    for (const m of materials) {
        for (const slot of TEXTURE_SLOTS) {
            const host = m[slot] ? m : m.pbrMetallicRoughness;
            if (host?.[slot]) host[slot].index = texUsed.index.get(host[slot].index);
        }
    }
    return {
        textures: { list: kept, samplers: smpUsed.order.map((i) => textures.samplers[i]) },
        images: { list: imgUsed.order.map((i) => images.list[i]) },
    };
}

function collect(items, visit) {
    const used = new Set();
    for (const item of items) visit(item, (i) => used.add(i));
    const order = [...used].sort((a, b) => a - b);
    return { order, index: new Map(order.map((old, now) => [old, now])) };
}
