// lodorder.js — the order that makes a prefix a level.
//
// PlayCanvas's octree LOD (scene/gsplat-unified) takes a level as one
// contiguous run of splats inside a file: `{ file, offset, count }`. So if a
// tile's splats are ordered such that every prefix is a fair sample of the
// whole, then level i is simply `offset 0, count n_i` — one file per tile, no
// repacking, no duplicated splats, and the levels are nested by construction,
// so nothing can pop that was not already there. PLAN-lod.md has the rest.
//
// A shuffle would make a prefix *statistically* fair, which is not enough: a
// random tenth of a surface reproduces its clumping and its voids, and reads
// as thin ground rather than as coarse ground. What is wanted is a prefix that
// covers the tile — one splat from every part of it, then two, then four.
//
// So: nested voxel grids, coarse to fine, and a splat's rank is the coarsest
// grid at which it is the one that speaks for its cell. Level 0 of the ladder
// is one splat per half-tile, level 8 one per five-hundredth, and the prefix
// at any boundary is exactly "a representative of every occupied cell down to
// here".
//
// Invariant 7 applies in full: `sog` is hash-compared on a second opinion
// (db/0016_sample.sql deterministic()), so two tabs must produce the same
// order from the same splats. client/atoms/merge.js:7-11 states the rules this
// obeys, and its `Grid` is the template — deliberately not reused, because
// `Grid.key` is load-bearing for merge-v1's bytes and must not move. Here:
// integer keys, a Map used only as an index and never iterated for the answer,
// every comparator total and settled on the geometry before the index, and
// nothing transcendental anywhere near a key.

import { bboxOf } from './ply.js';

// Grids, coarsest first. Level l has 2**(l+1) cells an axis: 2, 4 … 512.
export const LEVELS = 9;
// Cells an axis at the finest grid, and the packing radix.
export const AXIS = 2 ** (LEVELS - 1);
// A published level is never thinner than this: below it a level stops being
// a coarse tile and becomes a handful of splats in a 1.7 km box.
export const MIN_LEVEL = 256;
// And there are never more than this many, finest included.
export const MAX_LEVELS = 6;
// Each published level is at most this share of the next finer one. Halving a
// voxel edge quadruples the occupied cells of a *surface*, so the grids
// themselves land near this and the ladder comes out even.
export const RATIO = 4;

// How much of the world a splat covers: the area of its disc, times how much
// of it you can see. The smallest of the three extents is the one across the
// surface (client/atoms/train.js widen), so it is the other two that matter.
// Written with a fixed summation order, and no transcendental anywhere.
function weightOf(f, i) {
    const sx = f.sx[i], sy = f.sy[i], sz = f.sz[i];
    const mn = Math.min(sx, Math.min(sy, sz));
    const mx = Math.max(sx, Math.max(sy, sz));
    const mid = sx + sy + sz - mn - mx;
    return f.a[i] * (mx * mid + 1e-9);
}

// The finest cell a splat sits in, per axis, as exact integers. A coordinate
// that is not finite falls into cell 0 rather than poisoning the key: the
// comparison is written this way round so NaN takes the else.
function cellsOf(f, lo, cell) {
    const n = f.count;
    const ix = new Int32Array(n);
    const iy = new Int32Array(n);
    const iz = new Int32Array(n);
    const at = (v, base) => {
        const c = Math.floor((v - base) / cell);
        return c >= 0 ? (c <= AXIS - 1 ? c : AXIS - 1) : 0;
    };
    for (let i = 0; i < n; i++) {
        ix[i] = at(f.x[i], lo[0]);
        iy[i] = at(f.y[i], lo[1]);
        iz[i] = at(f.z[i], lo[2]);
    }
    return { ix, iy, iz };
}

// Whether i should speak for its cell instead of cur: wider, then earlier
// along the ground, then the earlier index.
function better(w, ix, iy, iz, i, cur) {
    if (w[i] !== w[cur]) return w[i] > w[cur];
    const a = keyAt(ix, iy, iz, i, 0);
    const b = keyAt(ix, iy, iz, cur, 0);
    return a !== b ? a < b : i < cur;
}

// The three indices at level l, packed. A shift of the finest quantisation, so
// no level can disagree with another about which cell a splat is in. At most
// (2**9)**3 = 2**27, exact as a double.
const keyAt = (ix, iy, iz, i, shift) =>
    (((ix[i] >> shift) * AXIS) + (iy[i] >> shift)) * AXIS + (iz[i] >> shift);

// The order, and where each grid's band ends. `order[t]` is the index of the
// splat that belongs at position t; `cum[l]` is how many splats the ladder
// holds down to and including level l.
export function lodOrder(f) {
    const n = f.count;
    if (n < 2) return { order: Uint32Array.from({ length: n }, (_, i) => i), levels: [n] };
    const box = bboxOf(f);
    const lo = [box[0], box[1], box[2]];
    const span = Math.max(box[3] - lo[0], Math.max(box[4] - lo[1], box[5] - lo[2]));
    if (!(span > 0)) return { order: Uint32Array.from({ length: n }, (_, i) => i), levels: [n] };

    const cell = span / AXIS;
    const { ix, iy, iz } = cellsOf(f, lo, cell);
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = weightOf(f, i);

    const order = new Uint32Array(n);
    const taken = new Uint8Array(n);
    const cum = [];
    let at = 0;
    for (let l = 0; l < LEVELS; l++) {
        const shift = LEVELS - 1 - l;
        // Elect one splat per occupied cell: the widest; on a tie the one
        // earlier along the ground; and only if two sit in the same finest
        // cell at the same width, the earlier index. Position before index, so
        // the answer is a property of the splats and not of the order they
        // happen to be stored in — the index is there to make the order total,
        // not to decide anything a tile could be asked about twice.
        //
        // The Map is an index only. The answer comes from the second walk
        // below, in index order, so nothing depends on its iteration
        // (client/atoms/merge.js:7-11).
        const best = new Map();
        for (let i = 0; i < n; i++) {
            if (taken[i]) continue;
            const k = keyAt(ix, iy, iz, i, shift);
            const cur = best.get(k);
            if (cur === undefined || better(w, ix, iy, iz, i, cur)) best.set(k, i);
        }
        const band = [];
        for (let i = 0; i < n; i++) {
            if (taken[i]) continue;
            const k = keyAt(ix, iy, iz, i, shift);
            if (best.get(k) === i) { band.push(i); taken[i] = 1; }
        }
        // Written in cell order, so the file reads along the ground rather
        // than in whatever order the election happened to find them.
        band.sort((a, b) => (keyAt(ix, iy, iz, a, shift) - keyAt(ix, iy, iz, b, shift)) || (a - b));
        for (const i of band) order[at++] = i;
        cum.push(at);
    }
    // Whatever was never elected — a cell's runners-up at every grid — in
    // finest-cell order, so the tail is coherent too.
    const rest = [];
    for (let i = 0; i < n; i++) if (!taken[i]) rest.push(i);
    rest.sort((a, b) => (keyAt(ix, iy, iz, a, 0) - keyAt(ix, iy, iz, b, 0)) || (a - b));
    for (const i of rest) order[at++] = i;
    cum.push(at);

    return { order, levels: lodLevelCounts(cum, n) };
}

// Which of the ladder's boundaries are worth publishing, finest first. The
// finest is always the whole tile; a coarser one is taken when it is at most a
// quarter of the last one taken and still has splats enough to be a picture.
// All integer arithmetic, so two tabs agree.
export function lodLevelCounts(cum, n) {
    const levels = [n];
    for (let l = cum.length - 1; l >= 0; l--) {
        const c = cum[l];
        if (c < MIN_LEVEL || c * RATIO > levels[levels.length - 1]) continue;
        levels.push(c);
        if (levels.length >= MAX_LEVELS) break;
    }
    return levels;
}
