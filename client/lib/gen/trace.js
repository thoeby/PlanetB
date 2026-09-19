// trace.js — a class raster into shapes.
//
// FND.13. When a land is assigned, the cover inside it stops being the
// operator's raster and becomes the landholder's own shapes: theirs to edit in
// QGIS, theirs to cut a clearing out of. This is the tracing, and it runs in
// the assigning admin's tab like every other piece of compute (Invariant 9).
//
// Marching squares over the cells of one class, then Douglas–Peucker to take
// the staircase off. Deterministic: the same raster gives the same rings in
// the same order, so assigning the same land twice would write the same
// shapes, and a shape is never a function of which pixel was visited first.

// The four corners of a cell, as a nibble: 1 = north-west, 2 = north-east,
// 4 = south-east, 8 = south-west. The two saddles (5, 10) are cut the same
// way every time — towards the corner pair — so a saddle never depends on
// which side it is entered from.
const SIDES = {
    1: [['w', 'n']], 2: [['n', 'e']], 3: [['w', 'e']],
    4: [['e', 's']], 5: [['w', 'n'], ['e', 's']], 6: [['n', 's']],
    7: [['w', 's']], 8: [['s', 'w']], 9: [['s', 'n']],
    10: [['n', 'e'], ['s', 'w']], 11: [['s', 'e']],
    12: [['e', 'w']], 13: [['e', 'n']], 14: [['n', 'w']],
};

// Where a side of cell (i, j) is, in cell coordinates. Half-way along it: the
// raster is classes and not a field, so there is nothing to interpolate.
const point = (i, j, side) => {
    if (side === 'n') return [i + 0.5, j];
    if (side === 's') return [i + 0.5, j + 1];
    if (side === 'w') return [i, j + 0.5];
    return [i + 1, j + 0.5];
};

const keyOf = (p) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;

/**
 * The outlines of everywhere `is(i, j)` holds, in cell coordinates.
 *
 * @param {function(number, number): boolean} is
 * @param {number} w cells across
 * @param {number} h cells down
 * @returns {number[][][]} closed rings, each at least a triangle
 */
export function outlines(is, w, h) {
    const at = (i, j) => (i < 0 || j < 0 || i >= w || j >= h ? false : is(i, j));
    // Every segment, from one side of a cell to another. Walked afterwards in
    // a fixed order, so the rings come out the same way every time.
    const from = new Map();
    for (let j = -1; j < h; j++) {
        for (let i = -1; i < w; i++) {
            const code = (at(i, j) ? 1 : 0) | (at(i + 1, j) ? 2 : 0)
                | (at(i + 1, j + 1) ? 4 : 0) | (at(i, j + 1) ? 8 : 0);
            for (const [a, b] of SIDES[code] ?? []) {
                const p = point(i, j, a);
                const q = point(i, j, b);
                const k = keyOf(p);
                if (!from.has(k)) from.set(k, []);
                from.get(k).push([p, q]);
            }
        }
    }
    return walk(from);
}

// The segments joined into rings. A segment is used once; the starts are taken
// in the order they were laid down, which is row-major over the cells.
function walk(from) {
    const rings = [];
    const used = new Set();
    let n = 0;
    for (const [, segs] of from) for (const s of segs) s.push(n++);
    for (const [, segs] of from) {
        for (const seg of segs) {
            if (used.has(seg[2])) continue;
            const ring = [seg[0]];
            let cur = seg;
            while (cur && !used.has(cur[2])) {
                used.add(cur[2]);
                ring.push(cur[1]);
                cur = (from.get(keyOf(cur[1])) ?? []).find((s) => !used.has(s[2]));
            }
            if (ring.length >= 4) rings.push(ring);
        }
    }
    return rings;
}

// Perpendicular distance from p to the line a–b.
const away = (p, a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (!len) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
};

/** Douglas–Peucker. `tol` is in the ring's own units. */
export function simplify(ring, tol) {
    if (ring.length < 3 || !(tol > 0)) return ring;
    const keep = new Uint8Array(ring.length);
    keep[0] = 1;
    keep[ring.length - 1] = 1;
    const stack = [[0, ring.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        let worst = 0;
        let at = -1;
        for (let i = a + 1; i < b; i++) {
            const d = away(ring[i], ring[a], ring[b]);
            if (d > worst) { worst = d; at = i; }
        }
        if (at > 0 && worst > tol) {
            keep[at] = 1;
            stack.push([a, at], [at, b]);
        }
    }
    return ring.filter((_, i) => keep[i]);
}

// Twice the signed area: positive for a ring wound one way, negative the
// other. Used to drop the specks marching squares leaves at a single cell.
export const ringArea = (ring) => {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        sum += a[0] * b[1] - b[0] * a[1];
    }
    return sum / 2;
};

/**
 * The shapes of one class, as rings in whatever `toWorld` maps a cell to.
 *
 * @param {function(number, number): boolean} is
 * @param {number} w
 * @param {number} h
 * @param {object} how {toWorld, tolerance, smallest}
 * @returns {number[][][]} rings, biggest first
 */
export function shapesOf(is, w, h, how = {}) {
    const toWorld = how.toWorld ?? ((x, y) => [x, y]);
    const out = [];
    for (const ring of outlines(is, w, h)) {
        const world = ring.map(([x, y]) => toWorld(x, y));
        const thin = simplify(world, Number(how.tolerance) || 0);
        if (thin.length < 4) continue;
        const area = Math.abs(ringArea(thin));
        if (area < (Number(how.smallest) || 0)) continue;
        out.push({ ring: thin, area });
    }
    out.sort((a, b) => b.area - a.area || a.ring[0][0] - b.ring[0][0]);
    return out.map((s) => s.ring);
}
