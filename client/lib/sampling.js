// sampling.js — turning a scene's surfaces into splats.
//
// Split out of client/atoms/assemble.js when that file outgrew four hundred
// lines. Both atoms that make splats out of geometry use it: `assemble` for the
// thirty per cent a trainer starts from, and `sample` for the whole of a tile
// that nobody is going to train (client/atoms/sample.js).
//
// Deterministic (Invariant 2): the triangles arrive in mesh order, the
// allocation is by largest remainder, and the only randomness is the seeded
// generator the caller hands in.

import { shade } from './light.js';
import { emptySplats } from './ply.js';
import { rng } from './poly.js';

// ---------------------------------------------------------------- sampling

const triangles = (meshes) => {
    const out = [];
    for (const m of meshes) {
        for (let i = 0; i < m.indices.length; i += 3) out.push([m, i]);
    }
    return out;
};

const vert = (m, i) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
const col = (m, i) => [m.colors[i * 3], m.colors[i * 3 + 1], m.colors[i * 3 + 2]];

function area(m, i) {
    const a = vert(m, m.indices[i]);
    const b = vert(m, m.indices[i + 1]);
    const c = vert(m, m.indices[i + 2]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0]) / 2;
}

// +Y onto the surface normal, so a splat lies flat on the face it came from.
function quatToNormal(n) {
    const d = n[1];
    if (d > 0.999999) return [1, 0, 0, 0];
    if (d < -0.999999) return [0, 0, 0, 1];
    const q = [1 + d, n[2], 0, -n[0]];
    const len = Math.hypot(q[0], q[1], q[2], q[3]);
    return q.map((v) => v / len);
}

// How much there is to see on one triangle, as a multiplier on its area. A
// hillside is one colour over hundreds of square metres and one splat every
// two metres of it is a splat nobody can tell from its neighbour; a roof edge,
// a tree, the line where a road meets the grass are all colour changing over
// centimetres, and that is where the same splats are worth spending.
//
// Both halves are the triangle's own: how far apart its three colours are, and
// how far apart its three normals point.
function detailOf(m, i) {
    const [ia, ib, ic] = [m.indices[i], m.indices[i + 1], m.indices[i + 2]];
    const cols = [col(m, ia), col(m, ib), col(m, ic)];
    let spread = 0;
    for (let c = 0; c < 3; c++) {
        const v = cols.map((q) => q[c]);
        spread += Math.max(...v) - Math.min(...v);
    }
    const ns = [ia, ib, ic].map((k) =>
        [m.normals[k * 3], m.normals[k * 3 + 1], m.normals[k * 3 + 2]]);
    let apart = 0;
    for (let a = 0; a < 3; a++) {
        const b = ns[(a + 1) % 3];
        apart = Math.max(apart, 1 - (ns[a][0] * b[0] + ns[a][1] * b[1] + ns[a][2] * b[2]));
    }
    return 1 + spread * 4 + apart * 3;
}

// Weighted by area and by what there is to see, by largest remainder so the
// counts add up exactly and do not depend on the order floating point rounds
// in. Returns each triangle's count and its own area, because a triangle that
// was given fewer splats needs bigger ones: one spacing for the whole tile
// leaves holes wherever the allocation went thin.
function allocate(tris, total) {
    const areas = tris.map(([m, i]) => area(m, i));
    const weights = tris.map(([m, i], k) => areas[k] * detailOf(m, i));
    const sum = weights.reduce((s, a) => s + a, 0) || 1;
    const exact = weights.map((a) => a / sum * total);
    const counts = exact.map(Math.floor);
    const left = total - counts.reduce((s, c) => s + c, 0);
    const order = exact.map((e, i) => [e - Math.floor(e), i])
        .sort((p, q) => q[0] - p[0] || p[1] - q[1]);
    for (let k = 0; k < left; k++) counts[order[k % order.length][1]] += 1;
    return { counts, areas, sum: areas.reduce((s, a) => s + a, 0) || 1 };
}

// The same fixed sun the ground mesh bakes and the frame atom shades with
// (client/lib/groundtile.js, client/lib/render.js). A surface sampled without
// it is a surface with no relief in it: flat colour, and darker than the ground
// beside it, which is the seam a player sees at a compiled tile's edge.

// `spread` is the in-plane radius of a splat as a share of the spacing of the
// triangle it came from. Samples land at random, not on a grid, so they clump
// and leave holes: at 0.7 the holes are the background showing through, which
// reads as dark speckle over the whole tile. Above 1 they overlap enough to be
// a surface.
//
// The spacing is the triangle's own — its area over how many splats it was
// given — because the allocation is no longer even: a flat hillside is given
// few and needs big ones, a roof edge is given many and needs small ones. One
// spacing for a whole tile was a tile with holes in half of it and a smear
// over the other half. It is capped against the tile's mean so a single huge
// triangle with one splat on it cannot put a hundred-metre blob in the world.
//
// `shaded` lights the surface's own colour with client/lib/light.js. `assemble`
// leaves it off: init.ply is what training starts from, and the frames it is
// trained against carry the light themselves.
const SPACING_CAP = 4;

export function sampleSurfaces(meshes, total, random,
    { spread = 0.7, shaded = false } = {}) {
    const tris = triangles(meshes);
    const { counts, areas, sum } = allocate(tris, total);
    const f = emptySplats(total);
    const mean = Math.sqrt(sum / Math.max(total, 1));
    let k = 0;
    for (let t = 0; t < tris.length; t++) {
        if (!counts[t]) continue;
        const [m, i] = tris[t];
        const ia = m.indices[i];
        const ib = m.indices[i + 1];
        const ic = m.indices[i + 2];
        const n = [m.normals[ia * 3], m.normals[ia * 3 + 1], m.normals[ia * 3 + 2]];
        const q = quatToNormal(n);
        const spacing = Math.min(Math.sqrt(areas[t] / counts[t]), mean * SPACING_CAP);
        for (let s = 0; s < counts[t]; s++, k++) {
            let u = random();
            let v = random();
            if (u + v > 1) { u = 1 - u; v = 1 - v; }
            const w = [1 - u - v, u, v];
            for (const [j, get] of [[0, vert], [1, col]]) {
                const p = [0, 0, 0];
                for (let c = 0; c < 3; c++) {
                    const val = get(m, [ia, ib, ic][c]);
                    p[0] += val[0] * w[c]; p[1] += val[1] * w[c]; p[2] += val[2] * w[c];
                }
                if (j === 0) { f.x[k] = p[0]; f.y[k] = p[1]; f.z[k] = p[2]; } else {
                    const lit = shaded ? shade(p, n) : p;
                    [f.r[k], f.g[k], f.b[k]] = lit.map((c) => Math.min(c, 1));
                }
            }
            f.a[k] = 1;
            f.sx[k] = spacing * spread;
            f.sy[k] = spacing * 0.15;
            f.sz[k] = spacing * spread;
            [f.qw[k], f.qx[k], f.qy[k], f.qz[k]] = q;
        }
    }
    return f;
}

export const rngOf = (atom, z, x, y) => rng((atom.seed ?? 0) + z * 1000003 + x * 1009 + y);
