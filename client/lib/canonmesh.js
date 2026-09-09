// canonmesh.js — the geometry half of canon-v1.
//
// Two exporters never agree on a scene graph: Blender writes a Z-up root
// rotation, a CAD tool writes centimetres as a 0.01 scale, another splits one
// mesh into four primitives and orders its vertices however its BVH happened
// to. None of that is the asset. So the tree is flattened into world space, the
// asset is re-centred on the bottom of its own bounding box, attributes are
// snapped to a fixed grid, and vertices and triangles are sorted. What survives
// is the shape — and two files with the same shape then have the same bytes.

import { NUM_COMPONENTS, readAccessor } from './glb.js';

// The grid every attribute lands on: 0.1 mm, a thousandth of a unit normal,
// a hundred-thousandth of a UV. Fine enough that nothing visibly moves, coarse
// enough that two exporters' float noise lands on the same point.
export const Q = { pos: 1e-4, nrm: 1e-3, uv: 1e-5 };

// ------------------------------------------------------------------ matrices

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a, b) {
    const out = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
        }
    }
    return out;
}

function nodeMatrix(node) {
    if (node.matrix) return node.matrix.slice();
    const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale ?? [1, 1, 1];
    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    return [
        (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
        (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
        (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
        tx, ty, tz, 1,
    ];
}

const point = (m, x, y, z) => [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
];

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]];

// Normals go through the inverse transpose, which for the columns c0 c1 c2 of
// the linear part is the reciprocal basis (c1xc2, c2xc0, c0xc1) over the
// determinant. The magnitude goes away when the normal is renormalised; the
// determinant's *sign* does not, and it is also what flips the winding.
function normalBasis(m) {
    const c = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
    const basis = [cross(c[1], c[2]), cross(c[2], c[0]), cross(c[0], c[1])];
    const det = c[0][0] * basis[0][0] + c[0][1] * basis[0][1] + c[0][2] * basis[0][2];
    return { basis, sign: det < 0 ? -1 : 1, flip: det < 0 };
}

// ------------------------------------------------------------------- flatten

function trianglesOf(gltf, buffers, prim) {
    const count = gltf.accessors[prim.attributes.POSITION].count;
    if (prim.indices === undefined) {
        return Uint32Array.from({ length: count }, (_, i) => i);
    }
    return Uint32Array.from(readAccessor(gltf, buffers, prim.indices));
}

function attribute(gltf, buffers, prim, name, want) {
    const index = prim.attributes[name];
    if (index === undefined) return null;
    const acc = gltf.accessors[index];
    if (acc.sparse) throw new Error('sparse accessors are not supported by canon-v1');
    if (NUM_COMPONENTS[acc.type] !== want) throw new Error(`${name} is not a VEC${want}`);
    return readAccessor(gltf, buffers, index);
}

function primitiveIn(gltf, buffers, prim, m) {
    if ((prim.mode ?? 4) !== 4) throw new Error(`primitive mode ${prim.mode} is not triangles`);
    const pos = attribute(gltf, buffers, prim, 'POSITION', 3);
    if (!pos) throw new Error('a primitive has no POSITION');
    const nrm = attribute(gltf, buffers, prim, 'NORMAL', 3);
    const uv = attribute(gltf, buffers, prim, 'TEXCOORD_0', 2);
    const { basis, sign, flip } = normalBasis(m);
    const n = pos.length / 3;
    const outPos = new Float64Array(n * 3);
    const outNrm = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
        outPos.set(point(m, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]), i * 3);
        const [x, y, z] = nrm ? [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]] : [0, 1, 0];
        outNrm.set(unit(covariant(basis, sign, x, y, z)), i * 3);
    }
    return { material: prim.material ?? null, pos: outPos, nrm: outNrm, uv,
        idx: trianglesOf(gltf, buffers, prim), flip };
}

const covariant = (b, sign, x, y, z) => [0, 1, 2].map((k) =>
    sign * (b[0][k] * x + b[1][k] * y + b[2][k] * z));

function unit(v) {
    const len = Math.hypot(v[0], v[1], v[2]);
    return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 1, 0];
}

// Every triangle of the default scene, in world space. A node outside the
// scene is not part of the asset and is dropped with the rest of the graph.
export function flattenPrimitives(gltf, buffers) {
    const out = [];
    const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes
        ?? (gltf.nodes ?? []).map((_, i) => i);
    const walk = (index, parent) => {
        const node = gltf.nodes[index];
        const m = mul(parent, nodeMatrix(node));
        if (node.mesh !== undefined) {
            for (const prim of gltf.meshes[node.mesh].primitives) {
                out.push(primitiveIn(gltf, buffers, prim, m));
            }
        }
        for (const child of node.children ?? []) walk(child, m);
    };
    for (const root of roots) walk(root, IDENTITY);
    return out;
}

// The origin is the bottom centre of the bounding box: an asset dropped on the
// terrain stands on it, whatever the exporter thought the origin was.
export function recentre(prims) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of prims) {
        for (let i = 0; i < p.pos.length; i += 3) {
            for (let c = 0; c < 3; c++) {
                min[c] = Math.min(min[c], p.pos[i + c]);
                max[c] = Math.max(max[c], p.pos[i + c]);
            }
        }
    }
    if (!Number.isFinite(min[0])) throw new Error('the GLB has no geometry');
    const shift = [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2];
    for (const p of prims) {
        for (let i = 0; i < p.pos.length; i += 3) {
            for (let c = 0; c < 3; c++) p.pos[i + c] += shift[c];
        }
    }
    const q = (v, c) => (Math.round((v + shift[c]) / Q.pos) + 0) * Q.pos;
    return { min: min.map(q), max: max.map(q) };
}

// ------------------------------------------------------------------ canonical

const key = (v) => v.join(',');

// `+ 0` turns -0 into 0. A rotation that lands a normal on -0 and one that
// lands it on 0 describe the same surface, and -0 compares equal to 0 — so
// without this the two files agree on every key and still write different
// bytes, which is the hardest kind of canon bug to see.
const snap = (value, grid) => Math.round(value / grid) + 0;

function quantise(p, i, withUv) {
    const k = [
        snap(p.pos[i * 3], Q.pos), snap(p.pos[i * 3 + 1], Q.pos), snap(p.pos[i * 3 + 2], Q.pos),
        snap(p.nrm[i * 3], Q.nrm), snap(p.nrm[i * 3 + 1], Q.nrm), snap(p.nrm[i * 3 + 2], Q.nrm),
    ];
    if (withUv) {
        k.push(snap(p.uv ? p.uv[i * 2] : 0, Q.uv), snap(p.uv ? p.uv[i * 2 + 1] : 0, Q.uv));
    }
    return k;
}

// One material's triangles: deduplicated, sorted by value rather than by the
// order they were authored in, and written out as float32 on the grid.
export function normaliseGroup(prims, withUv) {
    const seen = new Map();
    const verts = [];
    const tris = [];
    for (const p of prims) {
        const local = new Map();
        const at = (i) => {
            if (!local.has(i)) {
                const q = quantise(p, i, withUv);
                const k = key(q);
                if (!seen.has(k)) { seen.set(k, verts.length); verts.push(q); }
                local.set(i, seen.get(k));
            }
            return local.get(i);
        };
        for (let t = 0; t + 2 < p.idx.length; t += 3) {
            const abc = [at(p.idx[t]), at(p.idx[t + 1]), at(p.idx[t + 2])];
            if (p.flip) abc.reverse();
            if (abc[0] !== abc[1] && abc[1] !== abc[2] && abc[0] !== abc[2]) tris.push(abc);
        }
    }
    return emit(verts, tris, withUv);
}

function emit(verts, tris, withUv) {
    const order = verts.map((_, i) => i)
        .sort((a, b) => compare(verts[a], verts[b]));
    const rank = new Uint32Array(verts.length);
    order.forEach((old, now) => { rank[old] = now; });
    const wound = tris.map((t) => rotate(t.map((i) => rank[i])));
    const unique = [...new Map(wound.map((t) => [key(t), t])).values()]
        .sort((a, b) => compare(a, b));
    const n = order.length;
    const out = {
        positions: new Float32Array(n * 3), normals: new Float32Array(n * 3),
        uvs: withUv ? new Float32Array(n * 2) : null,
        indices: Uint32Array.from(unique.flat()),
    };
    order.forEach((old, i) => {
        const q = verts[old];
        for (let c = 0; c < 3; c++) out.positions[i * 3 + c] = q[c] * Q.pos;
        for (let c = 0; c < 3; c++) out.normals[i * 3 + c] = q[3 + c] * Q.nrm;
        if (withUv) for (let c = 0; c < 2; c++) out.uvs[i * 2 + c] = q[6 + c] * Q.uv;
    });
    return out;
}

const compare = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
};

// Same triangle, same winding, always starting at its lowest vertex.
const rotate = (t) => {
    const at = t.indexOf(Math.min(...t));
    return [t[at], t[(at + 1) % 3], t[(at + 2) % 3]];
};
