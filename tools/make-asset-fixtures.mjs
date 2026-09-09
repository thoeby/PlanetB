#!/usr/bin/env node
// WP4.1 — the five GLBs canon-v1 has to agree about.
//
// One model (a bench: a slab on two legs) written the way three different tools
// write it. Nothing here is clever: it is the same triangles, permuted,
// transformed, renamed and re-encoded exactly as real exporters differ, so that
// `client/test/canon.test.js` can assert all five reduce to one SAN.
//
//   blender.glb              Z-up root rotation, names and extras, two
//                            extensions canon drops, Uint32 indices
//   blender-interleaved.glb  one interleaved buffer with a byteStride,
//                            normalized uint16 UVs, and no index buffer at all
//   cad.glb                  centimetres (a 0.01 root scale), the origin at the
//                            model's corner, Uint16 indices, two child nodes,
//                            every spec default written out longhand
//   cad-split.glb            the same tool with each material's triangles split
//                            across two primitives, in reverse, under a deeper
//                            node chain
//   sketchfab.glb            metres and Y-up already, but the materials in the
//                            other order, the primitives swapped, and the
//                            vertices reversed
//
// Run: node tools/make-asset-fixtures.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGlb } from '../client/lib/glb.js';
import { encodePng } from '../client/lib/png.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../client/test/fixtures/assets');

// ------------------------------------------------------------------- the model

// A bench in metres, Y-up, standing on y = 0 and centred on x and z: the shape
// canon-v1 should arrive at whatever it is handed. Vertices are
// [x, y, z, nx, ny, nz, u, v].
const STRIDE = 8;

function bench() {
    const seat = box([-0.9, 0.42, -0.25], [0.9, 0.5, 0.25]);
    const legs = merge(box([-0.8, 0, -0.2], [-0.65, 0.42, 0.2]),
        box([0.65, 0, -0.2], [0.8, 0.42, 0.2]));
    return { seat, legs };
}

const FACES = [
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
    [[0, 0, -1], [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]],
    [[1, 0, 0], [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]]],
    [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
    [[0, 1, 0], [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
    [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
];

function box(min, max) {
    const v = [];
    const idx = [];
    for (const [n, corners] of FACES) {
        const base = v.length / STRIDE;
        for (const [cx, cy, cz] of corners) {
            v.push(min[0] + cx * (max[0] - min[0]), min[1] + cy * (max[1] - min[1]),
                min[2] + cz * (max[2] - min[2]), n[0], n[1], n[2], cx, cy);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return { v, idx };
}

function merge(a, b) {
    const shift = a.v.length / STRIDE;
    return { v: [...a.v, ...b.v], idx: [...a.idx, ...b.idx.map((i) => i + shift)] };
}

// A deterministic checkerboard, so the texture is real bytes rather than noise.
export function checker(width, height = width) {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const on = ((x >> 3) + (y >> 3)) % 2 === 0;
            rgba.set([on ? 190 : 120, on ? 150 : 90, 70, 255], (y * width + x) * 4);
        }
    }
    return encodePng(rgba, width, height);
}

// -------------------------------------------------------------- glTF plumbing

class Bin {
    constructor() { this.parts = []; this.at = 0; this.views = []; }

    add(data, extra = {}) {
        const pad = (4 - (this.at % 4)) % 4;
        if (pad) { this.parts.push(new Uint8Array(pad)); this.at += pad; }
        const u8 = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
        this.parts.push(u8);
        this.views.push({ buffer: 0, byteOffset: this.at, byteLength: u8.byteLength, ...extra });
        this.at += u8.byteLength;
        return this.views.length - 1;
    }

    bytes() {
        const out = new Uint8Array(this.at);
        let at = 0;
        for (const p of this.parts) { out.set(p, at); at += p.length; }
        return out;
    }
}

const minmax = (arr, n) => {
    const min = new Array(n).fill(Infinity);
    const max = new Array(n).fill(-Infinity);
    for (let i = 0; i < arr.length; i += n) {
        for (let c = 0; c < n; c++) {
            min[c] = Math.min(min[c], arr[i + c]);
            max[c] = Math.max(max[c], arr[i + c]);
        }
    }
    return { min, max };
};

const slot = (mesh, from, to) => new Float32Array(
    mesh.v.filter((_, i) => i % STRIDE >= from && i % STRIDE < to));

class Doc {
    constructor(generator, extra = {}) {
        this.bin = new Bin();
        this.accessors = [];
        this.json = { asset: { generator, version: '2.0' }, scene: 0, ...extra };
    }

    accessor(data, type, componentType, n, target, bounds) {
        const view = this.bin.add(data, { target });
        this.accessors.push({ bufferView: view, componentType, count: data.length / n, type,
            ...(bounds ? minmax(data, n) : {}) });
        return this.accessors.length - 1;
    }

    // Three separate accessors and an index buffer: what most exporters write.
    primitive(mesh, material, { short = false } = {}) {
        const attributes = {
            POSITION: this.accessor(slot(mesh, 0, 3), 'VEC3', 5126, 3, 34962, true),
            NORMAL: this.accessor(slot(mesh, 3, 6), 'VEC3', 5126, 3, 34962, false),
            TEXCOORD_0: this.accessor(slot(mesh, 6, 8), 'VEC2', 5126, 2, 34962, false),
        };
        const idx = short ? new Uint16Array(mesh.idx) : new Uint32Array(mesh.idx);
        return { attributes, material,
            indices: this.accessor(idx, 'SCALAR', short ? 5123 : 5125, 1, 34963, false) };
    }

    finish(image) {
        if (image !== undefined) {
            this.json.images = [{ mimeType: 'image/png', bufferView: this.bin.add(image) }];
        }
        this.json.accessors = this.accessors;
        this.json.bufferViews = this.bin.views;
        this.json.buffers = [{ byteLength: this.bin.at }];
        return buildGlb(this.json, this.bin.bytes());
    }
}

const MATERIALS = [
    { pbrMetallicRoughness: { baseColorFactor: [0.8, 0.62, 0.4, 1], metallicFactor: 0,
        roughnessFactor: 0.7, baseColorTexture: { index: 0 } } },
    { pbrMetallicRoughness: { baseColorFactor: [0.55, 0.56, 0.58, 1], metallicFactor: 1,
        roughnessFactor: 0.35 } },
];

// ------------------------------------------------------------------ exporters

// Blender is Z-up, so the exporter bakes the model into Z-up and puts a +90°
// X rotation on the root to bring it back.
const Z_UP = { rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] };

const toZup = (mesh) => ({ idx: mesh.idx, v: mesh.v.map((n, i) => {
    const k = i % STRIDE;
    if (k === 1 || k === 4) return mesh.v[i + 1];
    if (k === 2 || k === 5) return -mesh.v[i - 1];
    return n;
}) });

function blender(image) {
    const { seat, legs } = bench();
    const doc = new Doc('Khronos glTF Blender I/O v4.0.20', {
        extensionsUsed: ['KHR_texture_transform', 'EXT_mesh_gpu_instancing'],
        scenes: [{ name: 'Scene', nodes: [0] }],
        nodes: [{ name: 'Bench', mesh: 0, extras: { blender_object: 'Bench' }, ...Z_UP }],
        materials: MATERIALS.map((m, i) => ({ ...m, name: ['Wood.001', 'Steel'][i],
            extras: { blender: true },
            extensions: { KHR_texture_transform: { offset: [0, 0] } } })),
        textures: [{ name: 'wood', sampler: 0, source: 0 }],
        samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    });
    doc.json.meshes = [{ name: 'BenchMesh', primitives: [
        doc.primitive(toZup(seat), 0), doc.primitive(toZup(legs), 1)] }];
    return doc.finish(image);
}

// The same tool after a mesh-optimiser pass: one interleaved vertex buffer,
// UVs as normalized uint16, and the triangles unindexed.
function blenderInterleaved(image) {
    const { seat, legs } = bench();
    const doc = new Doc('Khronos glTF Blender I/O v4.0.20 + gltfpack', {
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, ...Z_UP }],
        materials: MATERIALS,
        textures: [{ sampler: 0, source: 0 }],
        samplers: [{ magFilter: 9729, minFilter: 9987 }],
    });
    doc.json.meshes = [{ primitives: [
        interleaved(doc, toZup(seat), 0), interleaved(doc, toZup(legs), 1)] }];
    return doc.finish(image);
}

function interleaved(doc, mesh, material) {
    const n = mesh.idx.length;
    const buf = new ArrayBuffer(n * 32);
    const f32 = new Float32Array(buf);
    const u16 = new Uint16Array(buf);
    mesh.idx.forEach((src, i) => {
        for (let c = 0; c < 6; c++) f32[i * 8 + c] = mesh.v[src * STRIDE + c];
        for (let c = 0; c < 2; c++) u16[i * 16 + 12 + c] = mesh.v[src * STRIDE + 6 + c] * 65535;
    });
    const view = doc.bin.add(new Uint8Array(buf), { target: 34962, byteStride: 32 });
    const acc = (byteOffset, type, componentType, count, extra) => {
        doc.accessors.push({ bufferView: view, byteOffset, componentType, count, type, ...extra });
        return doc.accessors.length - 1;
    };
    const pos = slot(mesh, 0, 3);
    return { material, attributes: {
        POSITION: acc(0, 'VEC3', 5126, n, minmax(pos, 3)),
        NORMAL: acc(12, 'VEC3', 5126, n, {}),
        TEXCOORD_0: acc(24, 'VEC2', 5123, n, { normalized: true }),
    } };
}

// A CAD exporter: centimetres, the origin at the model's own corner, Uint16
// indices, the mesh split across two child nodes, every default spelled out.
const CORNER = [0.9, 0, 0.25];
const toCm = (mesh) => ({ idx: mesh.idx, v: mesh.v.map((n, i) =>
    (i % STRIDE < 3 ? (n + CORNER[i % STRIDE]) * 100 : n)) });

const CAD_MATERIALS = MATERIALS.map((m) => ({ ...m, doubleSided: false,
    alphaMode: 'OPAQUE', alphaCutoff: 0.5, emissiveFactor: [0, 0, 0] }));

function cad(image) {
    const { seat, legs } = bench();
    const doc = new Doc('CADExchanger 3.19', {
        scenes: [{ nodes: [0] }],
        nodes: [{ children: [1, 2], scale: [0.01, 0.01, 0.01],
            translation: [-0.9, 0, -0.25] }, { mesh: 0 }, { mesh: 1 }],
        materials: CAD_MATERIALS,
        textures: [{ sampler: 0, source: 0 }],
        samplers: [{ wrapS: 10497, wrapT: 10497 }],
    });
    doc.json.meshes = [
        { primitives: [doc.primitive(toCm(seat), 0, { short: true })] },
        { primitives: [doc.primitive(toCm(legs), 1, { short: true })] },
    ];
    return doc.finish(image);
}

// The same, with each mesh cut into two primitives — back half first — under a
// deeper node chain that composes to the same transform.
function cadSplit(image) {
    const { seat, legs } = bench();
    const doc = new Doc('CADExchanger 3.19', {
        scenes: [{ nodes: [0] }],
        nodes: [{ children: [1], scale: [0.1, 0.1, 0.1], translation: [-0.9, 0, -0.25] },
            { children: [2, 3], scale: [0.1, 0.1, 0.1] }, { mesh: 0 }, { mesh: 1 }],
        materials: CAD_MATERIALS,
        textures: [{ sampler: 0, source: 0 }],
        samplers: [{ wrapS: 10497, wrapT: 10497 }],
    });
    doc.json.meshes = [seat, legs].map((mesh, m) => ({
        primitives: halves(toCm(mesh)).map((h) => doc.primitive(h, m, { short: true })) }));
    return doc.finish(image);
}

// Back half of the triangles first, then the front — the vertex buffer stays
// whole, so both primitives keep every vertex and canon has to drop the unused.
function halves(mesh) {
    const cut = Math.floor(mesh.idx.length / 6) * 3;
    return [{ v: mesh.v, idx: mesh.idx.slice(cut) }, { v: mesh.v, idx: mesh.idx.slice(0, cut) }];
}

// Sketchfab: metres and Y-up already, but the materials are declared the other
// way round, the primitives are swapped, and the vertices come out reversed.
function sketchfab(image) {
    const { seat, legs } = bench();
    const doc = new Doc('Sketchfab glTF exporter', {
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        materials: [MATERIALS[1], { ...MATERIALS[0], pbrMetallicRoughness: {
            ...MATERIALS[0].pbrMetallicRoughness, baseColorTexture: { index: 0, texCoord: 0 } } }],
        textures: [{ sampler: 0, source: 0 }],
        samplers: [{ magFilter: 9729, minFilter: 9987 }],
    });
    doc.json.meshes = [{ primitives: [
        doc.primitive(reversed(legs), 0), doc.primitive(reversed(seat), 1)] }];
    return doc.finish(image);
}

function reversed(mesh) {
    const n = mesh.v.length / STRIDE;
    const v = [];
    for (let i = n - 1; i >= 0; i--) v.push(...mesh.v.slice(i * STRIDE, (i + 1) * STRIDE));
    return { v, idx: mesh.idx.map((i) => n - 1 - i) };
}

// ----------------------------------------------------------------------- main

export const FIXTURES = { blender, 'blender-interleaved': blenderInterleaved,
    cad, 'cad-split': cadSplit, sketchfab };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const image = checker(64);
    mkdirSync(OUT, { recursive: true });
    for (const [name, make] of Object.entries(FIXTURES)) {
        const bytes = make(image);
        writeFileSync(join(OUT, `${name}.glb`), bytes);
        console.log(`${name}.glb: ${bytes.length} bytes`);
    }
}
