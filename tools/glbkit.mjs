// glbkit.mjs — the smallest glTF writer that writes a real GLB.
//
// tools/make-asset-fixtures.mjs has its own, on purpose: that one imitates
// three exporters' quirks, because canon-v1 has to agree about them, and its
// bytes are pinned by client/test/canon.test.js. This one writes one plain
// file the same way every time, for the fixture models of TASKS-foundation.md
// FND.0, and is free to stay boring.
//
// Positions are metres, Y up, the model standing on y = 0.

import { buildGlb } from '../client/lib/glb.js';

export const STRIDE = 8;   // x y z  nx ny nz  u v

const FACES = [
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
    [[0, 0, -1], [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]],
    [[1, 0, 0], [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]]],
    [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
    [[0, 1, 0], [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
    [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
];

/** An axis-aligned box from min to max, both [x, y, z] in metres. */
export function box(min, max) {
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

/** A four-sided pyramid on [±w, ±d] rising to `h`: a canopy, a roof, a rock. */
export function pyramid(w, d, y0, h, taper = 0) {
    const v = [];
    const idx = [];
    const base = [[-w, -d], [w, -d], [w, d], [-w, d]];
    const top = base.map(([x, z]) => [x * taper, z * taper]);
    for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        const [ax, az] = base[i], [bx, bz] = base[j];
        const [cx, cz] = top[j], [dx, dz] = top[i];
        const nx = (az - bz), nz = (bx - ax);
        const len = Math.hypot(nx, nz) || 1;
        const at = v.length / STRIDE;
        for (const [x, y, z, u, t] of [[ax, y0, az, 0, 0], [bx, y0, bz, 1, 0],
            [cx, y0 + h, cz, 1, 1], [dx, y0 + h, dz, 0, 1]]) {
            v.push(x, y, z, nx / len, 0.2, nz / len, u, t);
        }
        idx.push(at, at + 1, at + 2, at, at + 2, at + 3);
    }
    return { v, idx };
}

export function merge(...meshes) {
    const out = { v: [], idx: [] };
    for (const m of meshes) {
        const shift = out.v.length / STRIDE;
        out.v.push(...m.v);
        out.idx.push(...m.idx.map((i) => i + shift));
    }
    return out;
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

/**
 * One GLB: a scene of named nodes, each with one mesh of one material.
 * Node names matter — FND.6 marks a node as a live part by its name.
 */
export function model(parts, materials) {
    const bin = new Bin();
    const accessors = [];
    const acc = (data, type, componentType, n, target, bounds) => {
        const view = bin.add(data, { target });
        accessors.push({ bufferView: view, componentType, count: data.length / n, type,
            ...(bounds ? minmax(data, n) : {}) });
        return accessors.length - 1;
    };
    const meshes = [];
    const nodes = [];
    for (const { name, mesh, material } of parts) {
        meshes.push({ name: `${name}Mesh`, primitives: [{
            attributes: {
                POSITION: acc(slot(mesh, 0, 3), 'VEC3', 5126, 3, 34962, true),
                NORMAL: acc(slot(mesh, 3, 6), 'VEC3', 5126, 3, 34962, false),
                TEXCOORD_0: acc(slot(mesh, 6, 8), 'VEC2', 5126, 2, 34962, false),
            },
            material,
            indices: acc(new Uint32Array(mesh.idx), 'SCALAR', 5125, 1, 34963, false),
        }] });
        nodes.push({ name, mesh: meshes.length - 1 });
    }
    const json = {
        asset: { generator: 'splatworld tools/glbkit.mjs', version: '2.0' },
        scene: 0,
        scenes: [{ nodes: nodes.map((_, i) => i) }],
        nodes,
        meshes,
        materials,
        accessors,
        bufferViews: bin.views,
        buffers: [{ byteLength: bin.at }],
    };
    return buildGlb(json, bin.bytes());
}
