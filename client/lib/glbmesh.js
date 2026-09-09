// glbmesh.js — a canonical GLB as triangles this world can use.
//
// Two callers: `assemble`, which bakes a placed instance into the tile it
// falls in, and the catalog's thumbnail, which draws one on its own. Both want
// the same thing — positions, normals and a colour per vertex — because the
// renderer this repo ships has no textures and colour lives in the material
// (canon-v1 keeps no COLOR_0).
//
// Nothing here touches WebGL, so an atom in a Web Worker can import it.

import { Mesh } from './mesh.js';
import { parseGlb, readAccessor, resolveBuffers } from './glb.js';

const WHITE = [0.82, 0.82, 0.82];

// canon-v1 writes one primitive per material, so the base colour factor is the
// whole of an asset's colour as far as this renderer is concerned.
function colourOf(material) {
    const f = material?.pbrMetallicRoughness?.baseColorFactor;
    return f ? [f[0], f[1], f[2]] : WHITE;
}

// canon-v1 emits exactly one scene, one node with no transform, and one mesh
// (canon.js), which is why nothing here walks a node tree. Handed anything else
// — a raw export straight from a tool — it would silently drop that file's root
// rotation and answer with a model lying on its side, so it refuses instead.
function canonicalMesh(json) {
    const node = json.nodes?.length === 1 ? json.nodes[0] : null;
    const plain = node && node.mesh === 0 && !node.matrix && !node.rotation
        && !node.scale && !node.translation && !node.children;
    if (!plain || json.meshes?.length !== 1) {
        throw new Error('a canonical GLB is expected here: run canon-v1 over it first');
    }
    return json.meshes[0];
}

// One entry per primitive, in lib/mesh.js's unpacked shape.
export function meshesOf(glb) {
    const { json, bin } = parseGlb(glb);
    const buffers = resolveBuffers(json, bin);
    return canonicalMesh(json).primitives.map((prim) => {
        const positions = Float32Array.from(readAccessor(json, buffers, prim.attributes.POSITION));
        const normals = Float32Array.from(readAccessor(json, buffers, prim.attributes.NORMAL));
        const colour = colourOf(json.materials?.[prim.material]);
        const colors = new Float32Array(positions.length);
        for (let i = 0; i < colors.length; i += 3) colors.set(colour, i);
        return { positions, normals, colors,
            indices: Uint32Array.from(readAccessor(json, buffers, prim.indices)) };
    });
}

export function boundsOf(meshes) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const m of meshes) {
        for (let i = 0; i < m.positions.length; i += 3) {
            for (let c = 0; c < 3; c++) {
                min[c] = Math.min(min[c], m.positions[i + c]);
                max[c] = Math.max(max[c], m.positions[i + c]);
            }
        }
    }
    return { min, max };
}

// ----------------------------------------------------------------- placement

// Yaw about up, then pitch about east, then roll about north — the order the
// instance columns are written in, applied to a Y-up asset in the tile's own
// ENU frame. Returned column-major-free: a plain 3x3 as nine numbers, rows
// first, because it is only ever multiplied by a vector here.
export function basisOf(yaw, pitch, roll, scale = 1) {
    const [cy, sy] = [Math.cos(yaw), Math.sin(yaw)];
    const [cp, sp] = [Math.cos(pitch), Math.sin(pitch)];
    const [cr, sr] = [Math.cos(roll), Math.sin(roll)];
    const m = [
        cy * cr + sy * sp * sr, sy * sp * cr - cy * sr, sy * cp,
        cp * sr, cp * cr, -sp,
        cy * sp * sr - sy * cr, sy * sr + cy * sp * cr, cy * cp,
    ];
    return m.map((v) => v * scale + 0);          // + 0 so a zero is never -0
}

const apply = (m, x, y, z) => [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
];

// A normal must not be stretched by the scale, and the scale here is uniform,
// so the rotation alone is the right transform once it is renormalised.
const unit = (v) => {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
};

// The asset, placed: `at` is the position in the destination frame, metres.
// Returns lib/mesh.js Mesh objects, ready to go into `assemble`'s mesh list.
export function placeMeshes(glb, { at, yaw = 0, pitch = 0, roll = 0, scale = 1,
    material = 'asset' } = {}) {
    const basis = basisOf(yaw, pitch, roll, scale);
    return meshesOf(glb).map((src) => {
        const mesh = new Mesh(material);
        for (let i = 0; i < src.positions.length; i += 3) {
            const p = apply(basis, src.positions[i], src.positions[i + 1], src.positions[i + 2]);
            const n = unit(apply(basis, src.normals[i], src.normals[i + 1], src.normals[i + 2]));
            mesh.vertex([at[0] + p[0], at[1] + p[1], at[2] + p[2]], n,
                [src.colors[i], src.colors[i + 1], src.colors[i + 2]]);
        }
        for (let i = 0; i < src.indices.length; i += 3) {
            mesh.tri(src.indices[i], src.indices[i + 1], src.indices[i + 2]);
        }
        return mesh;
    });
}
