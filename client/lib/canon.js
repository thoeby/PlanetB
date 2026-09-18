// canon.js — canon-v1: the normal form a GLB has to be in before the world
// will give it a number.
//
// A SAN is `S` + base32(sha256(canonical GLB))[:12] (ARCHITECTURE §1), so two
// uploads of the same model must produce the same bytes or the catalog fills up
// with duplicates nobody can tell apart. Exporters do not cooperate: they
// disagree on scene graphs, units, up axis, vertex order, which defaults to
// write and which extensions to add. canon-v1 removes all of it.
//
//   1. flatten the scene graph into world space (canonmesh.js)
//   2. re-centre on the bottom centre of the bounding box; Y-up, metres, as
//      glTF already defines them
//   3. quantise, deduplicate and sort vertices and triangles
//   4. reduce materials, textures and images to their normal form (canontex.js)
//   5. write one scene, one node, one mesh, one buffer, in a fixed order, with
//      every JSON object's keys sorted
//
// Vertex colours are not part of the canonical form in v1: colour lives in the
// material, and COLOR_0 is the attribute exporters disagree about most.
// Textures within budget keep their exact bytes — an asset whose pixels differ
// is a different asset. Extensions other than KHR_materials_* are dropped, so
// what the world stores is what any glTF 2.0 renderer can draw.

import { buildGlb, parseGlb, resolveBuffers, sortKeys } from './glb.js';
import { flattenPrimitives, normaliseGroup, recentre } from './canonmesh.js';
import { canonImages, canonMaterials, canonTextures, extensionsOf, prune, usesTexture }
    from './canontex.js';
import { inflateDraco } from './draco.js';
import { sha256 } from './hash.js';

export const CANON_VERSION = 1;
export const ALGO = 'canon-v1';

// canon-v2 (FND.6) is canon-v1 with the maker's marked nodes left standing as
// meshes of their own, named `part:<name>`, in the order of their names. A GLB
// with no markings is canon-v1 and keeps the number it always had.
export const CANON_V2 = 2;
export const ALGO_V2 = 'canon-v2';
export const PART_PREFIX = 'part:';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// The catalog number: 60 bits of the digest, RFC 4648 base32, so it can be read
// aloud and typed. db/0020_assets.sql derives it the same way, and its answer
// is the one that counts — a client cannot name its own asset.
export function sanOf(hex) {
    let out = 'S';
    for (let i = 0; i < 12; i++) {
        const bit = i * 5;
        const byte = bit >> 3;
        const win = (parseInt(hex.slice(byte * 2, byte * 2 + 2), 16) << 8)
            | parseInt(hex.slice(byte * 2 + 2, byte * 2 + 4), 16);
        out += B32[(win >> (11 - (bit & 7))) & 31];
    }
    return out;
}

// ------------------------------------------------------------------- buffer

// Views are appended in the order the accessors are written, each aligned to 4
// bytes, so the buffer's layout is a function of the mesh and nothing else.
class Buffers {
    constructor() { this.parts = []; this.views = []; this.at = 0; }

    view(bytes, extra = {}) {
        const pad = (4 - (this.at % 4)) % 4;
        if (pad) { this.parts.push(new Uint8Array(pad)); this.at += pad; }
        const u8 = ArrayBuffer.isView(bytes)
            ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            : new Uint8Array(bytes);
        this.parts.push(u8);
        this.views.push({ buffer: 0, byteOffset: this.at, byteLength: u8.byteLength, ...extra });
        this.at += u8.byteLength;
        return this.views.length - 1;
    }

    bytes() {
        const out = new Uint8Array(this.at + ((4 - (this.at % 4)) % 4));
        let at = 0;
        for (const p of this.parts) { out.set(p, at); at += p.length; }
        return out;
    }
}

const bounds = (data, n) => {
    const min = new Array(n).fill(Infinity);
    const max = new Array(n).fill(-Infinity);
    for (let i = 0; i < data.length; i += n) {
        for (let c = 0; c < n; c++) {
            min[c] = Math.min(min[c], data[i + c]);
            max[c] = Math.max(max[c], data[i + c]);
        }
    }
    return { min, max };
};

// ---------------------------------------------------------------- assembly

function writeGroup(blob, accessors, group) {
    const attributes = {};
    const put = (data, type, componentType, n, target, withBounds) => {
        const view = blob.view(data, { target });
        const acc = { bufferView: view, componentType, count: data.length / n, type };
        if (withBounds) Object.assign(acc, bounds(data, n));
        accessors.push(acc);
        return accessors.length - 1;
    };
    attributes.POSITION = put(group.positions, 'VEC3', 5126, 3, 34962, true);
    attributes.NORMAL = put(group.normals, 'VEC3', 5126, 3, 34962, false);
    if (group.uvs) attributes.TEXCOORD_0 = put(group.uvs, 'VEC2', 5126, 2, 34962, false);
    const indices = put(group.indices, 'SCALAR', 5125, 1, 34963, false);
    return { attributes, indices };
}

// One mesh's triangles, grouped by material. `slot` maps a material's index in
// the canonical list to its index in the GLB's material array, which is shared
// by every mesh of the file — under canon-v1 there is only one.
function buildGroups(prims, materials, slot) {
    const byMaterial = new Map();
    const fallback = materials.remap[materials.remap.length - 1];
    for (const p of prims) {
        const m = p.material === null ? fallback : materials.remap[p.material];
        if (!byMaterial.has(m)) byMaterial.set(m, []);
        byMaterial.get(m).push(p);
    }
    const kept = [...byMaterial.keys()].sort((a, b) => a - b);
    return kept.map((m) => ({
        material: slot(m),
        source: materials.list[m],
        group: normaliseGroup(byMaterial.get(m), usesTexture(materials.list[m])),
    }));
}

// The body first, then one mesh per part in the order of their names — which
// is the order `parts` is already in (client/lib/marks.js).
function buildMeshes(prims, materials, parts) {
    const used = new Set();
    const fallback = materials.remap[materials.remap.length - 1];
    for (const p of prims) {
        used.add(p.material === null ? fallback : materials.remap[p.material]);
    }
    const order = [...used].sort((a, b) => a - b);
    const slot = (m) => order.indexOf(m);
    const named = [...new Set(prims.map((p) => p.part).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    const body = prims.filter((p) => !p.part);
    const meshes = body.length
        ? [{ name: null, groups: buildGroups(body, materials, slot) }] : [];
    for (const name of named) {
        meshes.push({ name: PART_PREFIX + name,
            groups: buildGroups(prims.filter((p) => p.part === name), materials, slot) });
    }
    if (parts) {
        for (const p of parts.values()) {
            if (!named.includes(p)) throw new Error(`the part ${p} has no geometry`);
        }
    }
    return { meshes, materials: order.map((m) => materials.list[m]) };
}

function assemble(built, textures, images, version) {
    const blob = new Buffers();
    const accessors = [];
    const meshes = built.meshes.map((m) => ({
        primitives: m.groups.map((g) =>
            ({ ...writeGroup(blob, accessors, g.group), material: g.material })),
    }));
    const imageEntries = images.list.map((img) =>
        ({ mimeType: img.mime, bufferView: blob.view(img.bytes) }));
    const gltf = {
        asset: { generator: version === CANON_V2 ? ALGO_V2 : ALGO, version: '2.0' },
        scene: 0,
        scenes: [{ nodes: built.meshes.map((_, i) => i) }],
        nodes: built.meshes.map((m, i) => (m.name ? { mesh: i, name: m.name } : { mesh: i })),
        meshes,
        materials: built.materials,
        accessors,
        bufferViews: blob.views,
    };
    if (imageEntries.length) {
        gltf.images = imageEntries;
        gltf.textures = textures.list;
        if (textures.samplers.length) gltf.samplers = textures.samplers;
    }
    const ext = extensionsOf(gltf.materials);
    if (ext.length) gltf.extensionsUsed = ext;
    const bin = blob.bytes();
    gltf.buffers = [{ byteLength: bin.length }];
    return { gltf, bin, texBytes: images.list.reduce((n, i) => n + i.bytes.length, 0) };
}

// ------------------------------------------------------------------- entry

// `decodeImage(bytes, info) -> {width, height, data}` is only needed to shrink
// an oversized non-PNG texture; `decodeDraco` only for a compressed mesh.
// Neither is reachable from node without a vendored decoder, and a GLB that
// needs one says so rather than producing a second, wrong canonical form.
export async function canonicalise(bytes, { decodeImage, decodeDraco, parts } = {}) {
    const { json, bin } = parseGlb(bytes);
    const buffers = resolveBuffers(json, bin);
    await inflateDraco(json, buffers, decodeDraco);
    const marked = parts?.size ? parts : null;
    const version = marked ? CANON_V2 : CANON_VERSION;
    const prims = flattenPrimitives(json, buffers, marked);
    const bbox = recentre(prims);
    const images = await canonImages(json, buffers, decodeImage);
    const textures = canonTextures(json, images);
    const materials = canonMaterials(json, textures);
    const built = buildMeshes(prims, materials, marked);
    const live = prune(built.materials, textures, images);
    const { gltf, bin: out, texBytes } = assemble(built, live.textures, live.images, version);
    const glb = buildGlb(sortKeys(gltf), out);
    const hex = await sha256(glb);
    const groups = built.meshes.flatMap((m) => m.groups);
    return {
        glb,
        sha256: hex,
        // canon-v2's number is not the GLB's alone: the same file with
        // different markings is a different product, so db/0138 derives it
        // from both and this tab does not name it (Invariant 6).
        san: marked ? null : sanOf(hex),
        canon_version: version,
        meta: {
            bbox,
            tris: groups.reduce((n, g) => n + g.group.indices.length / 3, 0),
            vertices: groups.reduce((n, g) => n + g.group.positions.length / 3, 0),
            tex_bytes: texBytes,
            materials: gltf.materials.length,
        },
    };
}
