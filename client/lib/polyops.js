// polyops.js — union, difference and intersection of areas (EDT.20, EDT.21;
// PLAN-editors.md §2.4).
//
// Done on a fine raster rather than on the rings: each polygon is filled into
// a grid of cells a few centimetres to a quarter metre across (finer for a
// smaller extent), the grids are combined cell by cell, and the result is
// traced back into rings by marching squares and simplified. It is exact to
// the cell and it never fails on the cases vector clipping does — a painted
// blob of a hundred overlapping circles, rings that touch, a hole cut through
// a hole. Deterministic: the same inputs are the same rings (Invariant 2).
//
// Polygons are [[outer, hole, …], …] of rings of [x, z] metres in a local
// frame (client/lib/spline.js frameAt). Node-tested (client/test/polyops.test.js).

import { simplify, toSegment } from './spline.js';

// The finest cell, and the most cells across the longer side.
const MIN_CELL = 0.05;
const MAX_ACROSS = 1600;

export function ringArea(ring) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    }
    return a / 2;
}

export const areaOf = (polys) => polys.reduce((s, p) =>
    s + Math.abs(ringArea(p[0])) - p.slice(1).reduce((h, r) => h + Math.abs(ringArea(r)), 0), 0);

function extentOf(...sets) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const polys of sets) {
        for (const p of polys) {
            for (const [x, z] of p[0]) {
                b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], z);
                b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], z);
            }
        }
    }
    return b;
}

// A grid over an extent, a cell of margin all round so every ring closes.
export function gridOver(b) {
    const span = Math.max(b[2] - b[0], b[3] - b[1], 1e-6);
    const cell = Math.max(MIN_CELL, span / MAX_ACROSS);
    const x0 = b[0] - 2 * cell;
    const z0 = b[1] - 2 * cell;
    return { x0, z0, cell, cols: Math.ceil((b[2] - x0) / cell) + 3,
        rows: Math.ceil((b[3] - z0) / cell) + 3 };
}

/**
 * The cells whose centres fall inside `polys` (even-odd over each polygon's
 * rings), a scanline a row.
 */
export function rasterize(polys, g, into = new Uint8Array(g.cols * g.rows)) {
    for (const p of polys) {
        const row = new Uint8Array(g.cols * g.rows);
        for (let j = 0; j < g.rows; j++) {
            const z = g.z0 + (j + 0.5) * g.cell;
            const xs = [];
            for (const ring of p) {
                for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
                    const [ax, az] = ring[k];
                    const [bx, bz] = ring[i];
                    if ((az > z) !== (bz > z)) xs.push(ax + (z - az) / (bz - az) * (bx - ax));
                }
            }
            xs.sort((a, b) => a - b);
            for (let n = 0; n + 1 < xs.length; n += 2) {
                const i0 = Math.max(0, Math.ceil((xs[n] - g.x0) / g.cell - 0.5));
                const i1 = Math.min(g.cols - 1, Math.floor((xs[n + 1] - g.x0) / g.cell - 0.5));
                for (let i = i0; i <= i1; i++) row[j * g.cols + i] = 1;
            }
        }
        for (let k = 0; k < row.length; k++) into[k] |= row[k];
    }
    return into;
}

// Filled circles of `r` metres at each centre, into the grid.
export function circles(centres, r, g, into = new Uint8Array(g.cols * g.rows)) {
    for (const [cx, cz] of centres) {
        const j0 = Math.max(0, Math.floor((cz - r - g.z0) / g.cell));
        const j1 = Math.min(g.rows - 1, Math.ceil((cz + r - g.z0) / g.cell));
        for (let j = j0; j <= j1; j++) {
            const dz = g.z0 + (j + 0.5) * g.cell - cz;
            if (Math.abs(dz) > r) continue;
            const w = Math.sqrt(r * r - dz * dz);
            const i0 = Math.max(0, Math.ceil((cx - w - g.x0) / g.cell - 0.5));
            const i1 = Math.min(g.cols - 1, Math.floor((cx + w - g.x0) / g.cell - 0.5));
            for (let i = i0; i <= i1; i++) into[j * g.cols + i] = 1;
        }
    }
    return into;
}

export { traceMask } from './polytrace.js';
import { traceMask } from './polytrace.js';

// Two sets of polygons combined cell by cell.
function combine(a, b, op, tol) {
    if (!a.length && !b.length) return [];
    const g = gridOver(extentOf(a, b));
    const ma = rasterize(a, g);
    const mb = rasterize(b, g);
    const out = new Uint8Array(ma.length);
    for (let k = 0; k < out.length; k++) out[k] = op(ma[k], mb[k]);
    return traceMask(out, g, tol ?? Math.max(g.cell, 0.05));
}

export const union = (a, b, tol) => combine(a, b, (x, y) => x | y, tol);
export const difference = (a, b, tol) => combine(a, b, (x, y) => x & (1 - y), tol);
export const intersection = (a, b, tol) => combine(a, b, (x, y) => x & y, tol);

// Whether two sets of polygons share any ground at all.
export function overlaps(a, b) {
    if (!a.length || !b.length) return false;
    const g = gridOver(extentOf(a, b));
    const ma = rasterize(a, g);
    const mb = rasterize(b, g);
    for (let k = 0; k < ma.length; k++) if (ma[k] & mb[k]) return true;
    return false;
}

// A brush's strokes as polygons: every circle, one area (idea 29).
export function paintedOf(centres, r, tol) {
    if (!centres.length) return [];
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, z] of centres) {
        b[0] = Math.min(b[0], x - r); b[1] = Math.min(b[1], z - r);
        b[2] = Math.max(b[2], x + r); b[3] = Math.max(b[3], z + r);
    }
    const g = gridOver(b);
    return traceMask(circles(centres, r, g), g, tol ?? Math.max(g.cell, 0.1));
}

export { simplify };

// Every corner of `polys` that the raster left a few centimetres past the
// edge of `land`, put back onto that edge: clipped to the land means inside
// it, not inside it to the cell (PLAN-editors D5).
export function pullInside(polys, land) {
    const rings = land.flat();
    const inLand = (p) => land.some((poly) => {
        let on = false;
        for (const ring of poly) {
            for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
                const [ax, az] = ring[k];
                const [bx, bz] = ring[i];
                if ((az > p[1]) !== (bz > p[1])
                    && p[0] < (bx - ax) * (p[1] - az) / (bz - az) + ax) on = !on;
            }
        }
        return on;
    });
    const onto = (p) => {
        let best = null;
        for (const ring of rings) {
            for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
                const s = toSegment(p, ring[k], ring[i]);
                if (!best || s.d < best.d) best = s;
            }
        }
        return best ? best.foot : p;
    };
    return polys.map((poly) => poly.map((ring) => ring.map((p) => (inLand(p) ? p : onto(p)))));
}
