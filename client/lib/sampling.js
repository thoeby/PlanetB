// sampling.js — turning a scene's surfaces into splats.
//
// Split out of client/atoms/assemble.js when that file outgrew four hundred
// lines: `assemble` seeds the splats a trainer starts from with it.
//
// Deterministic (Invariant 2): the triangles arrive in mesh order, the
// allocation is by largest remainder, and the only randomness is the seeded
// generator the caller hands in.

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
// How much of the budget is spread by area alone, before detail is allowed an
// opinion. Detail decides where the *rest* goes.
//
// Weighting purely by area x detail starves smooth ground by up to sixteen to
// one, and what covered the thin places was the size of the splats given to
// them — one splat per triangle, made big enough to reach its neighbour. That
// is the same thing as SPREAD being 1.15: a tile held together by overlap,
// which reads as a smear. Cut the overlap and the thin places are holes,
// which is what they always were.
//
// So: four fifths of the budget goes by area, which covers the ground
// evenly whatever is on it, and the last fifth goes by area x detail, which
// is where the edges and the colour changes get their extra. Coverage stops
// depending on how big a splat is allowed to be.
const EVEN_SHARE = 0.8;

function allocate(tris, total) {
    const areas = tris.map(([m, i]) => area(m, i));
    const flat = areas.reduce((s, a) => s + a, 0) || 1;
    const weights = tris.map(([m, i], k) => areas[k] * detailOf(m, i));
    const sum = weights.reduce((s, a) => s + a, 0) || 1;
    const exact = tris.map((_, k) => (areas[k] / flat) * total * EVEN_SHARE
        + (weights[k] / sum) * total * (1 - EVEN_SHARE));
    const counts = exact.map(Math.floor);
    const left = total - counts.reduce((s, c) => s + c, 0);
    const order = exact.map((e, i) => [e - Math.floor(e), i])
        .sort((p, q) => q[0] - p[0] || p[1] - q[1]);
    for (let k = 0; k < left; k++) counts[order[k % order.length][1]] += 1;
    return { counts, areas, sum: areas.reduce((s, a) => s + a, 0) || 1 };
}

// The same fixed sun the ground mesh bakes and the frame atom shades with
// (client/lib/raster.js). A surface sampled without
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
const SPACING_CAP = 4;
// And floored against it, because a scale of zero is a log-scale of minus
// infinity to the trainer (client/lib/brush.js), which poisons the run a
// hundred steps later as a splat with no finite size at all. A degenerate
// triangle — the terrain cuts and the road meshes make them — can be handed a
// splat by the remainder in `allocate`, and its area is zero.
const SPACING_FLOOR = 0.01;

// Where in its triangle each sample lands. Uniformly random positions clump
// and leave voids at every density — a hundred thousand of them over a tile
// had patches with nothing in them that no amount of training filled, because
// nothing was there to move. `even` places a triangle's n samples on the R2
// sequence (Roberts' low-discrepancy sequence: spacing about as regular as a
// lattice, no rows), from a random phase per triangle so neighbours do not
// line up. Deterministic from the same seed, so the same seed is the same
// seed (Invariant 2). Off, it is what assemble-v4's init.ply was made with.
const R2 = [0.7548776662466927, 0.5698402909980532];

export function sampleSurfaces(meshes, total, random,
    { spread = 0.7, even = false } = {}) {
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
        const spacing = Math.min(Math.max(Math.sqrt(areas[t] / counts[t]),
            mean * SPACING_FLOOR), mean * SPACING_CAP);
        const phase = even ? [random(), random()] : null;
        for (let s = 0; s < counts[t]; s++, k++) {
            let u = even ? (phase[0] + s * R2[0]) % 1 : random();
            let v = even ? (phase[1] + s * R2[1]) % 1 : random();
            if (u + v > 1) { u = 1 - u; v = 1 - v; }
            const w = [1 - u - v, u, v];
            for (const [j, get] of [[0, vert], [1, col]]) {
                const p = [0, 0, 0];
                for (let c = 0; c < 3; c++) {
                    const val = get(m, [ia, ib, ic][c]);
                    p[0] += val[0] * w[c]; p[1] += val[1] * w[c]; p[2] += val[2] * w[c];
                }
                if (j === 0) { f.x[k] = p[0]; f.y[k] = p[1]; f.z[k] = p[2]; } else {
                    [f.r[k], f.g[k], f.b[k]] = p.map((c) => Math.min(c, 1));
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

// Two sets of splats, one after the other. Generic over the fields, the way
// `permute` is: it joins whatever a splat set carries.
export function joinSplats(a, b) {
    if (!a.count) return b;
    if (!b.count) return a;
    const out = { count: a.count + b.count };
    for (const k of Object.keys(a)) {
        if (k === 'count') continue;
        out[k] = new a[k].constructor(out.count);
        out[k].set(a[k]);
        out[k].set(b[k], a.count);
    }
    return out;
}

// The ground is seeded on its own, whatever else stands on the tile.
// `allocate` spends a fifth of the budget by area x detail, and `detailOf`
// runs from 1 on smooth uniform ground to about 16 on an edge — so on a tile
// with buildings and trees on it the ground is the surface that loses. Four
// hundred square metres of roof and wall over a hundred-metre square of ground
// took five sixths of the seed, and the ground's splats ended up 1.8 m apart
// where the roofs' were centimetres.
//
// Sampled by itself it is given at least `floor` of the seed however little
// there is to see on it, and its own area share even where `floor` is nothing.
// Everything that stands on it is sampled exactly as it always was.
export const isGround = (m) => m.material === 'terrain';

export function seedSurfaces(meshes, total, random, { floor = 0, ...how } = {}) {
    const ground = meshes.filter(isGround);
    const rest = meshes.filter((m) => !isGround(m));
    if (!ground.length || !rest.length) return sampleSurfaces(meshes, total, random, how);
    const spread = (list) => triangles(list).reduce((s, [m, i]) => s + area(m, i), 0);
    const mine = spread(ground);
    const share = Math.max(mine / (mine + spread(rest) || 1), floor);
    const n = Math.min(Math.max(Math.round(total * share), 1), total - 1);
    // The ground first, so a prefix of the seed is mostly ground: the preview
    // reads a prefix, and a preview of the trees is not a preview of the tile.
    return joinSplats(sampleSurfaces(ground, n, random, how),
        sampleSurfaces(rest, total - n, random, how));
}

export const rngOf = (atom, z, x, y) => rng((atom.seed ?? 0) + z * 1000003 + x * 1009 + y);
