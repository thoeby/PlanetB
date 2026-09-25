// contour.js — lines of equal value over a grid, by marching squares
// (PLAN-editors.md idea 1; EDT.2).
//
// Contours are lines of equal height; the 5 m grid is the same thing over the
// east and south coordinates. Both are drawn on the Blueprint mesh, not as a
// layer beside it. Pure: node-tested on a synthetic cone
// (client/test/contour.test.js).

/**
 * Segments where `value(i, j)` crosses a multiple of `every`, over the cells
 * of [i0, i1] × [j0, j1]. Each segment is [fi, fj, fi, fj, level]: two points
 * as fractional grid positions, and the level it is at.
 */
export function isolines(value, i0, j0, i1, j1, every) {
    const out = [];
    for (let j = j0; j < j1; j++) {
        for (let i = i0; i < i1; i++) {
            const c = [value(i, j), value(i + 1, j), value(i + 1, j + 1), value(i, j + 1)];
            const lo = Math.min(...c);
            const hi = Math.max(...c);
            for (let level = Math.ceil(lo / every) * every; level <= hi; level += every) {
                cell(out, i, j, c, level);
            }
        }
    }
    return out;
}

// The four corners, clockwise from the north-west, and the edges between them.
const CORNER = [[0, 0], [1, 0], [1, 1], [0, 1]];

function cell(out, i, j, c, level) {
    const pts = [];
    for (let e = 0; e < 4; e++) {
        const a = c[e] - level;
        const b = c[(e + 1) % 4] - level;
        // A corner exactly on the level counts as above it, so a line through
        // a vertex is drawn once rather than twice or not at all.
        if ((a >= 0) === (b >= 0)) continue;
        const t = a / (a - b);
        const [ax, ay] = CORNER[e];
        const [bx, by] = CORNER[(e + 1) % 4];
        pts.push([i + ax + (bx - ax) * t, j + ay + (by - ay) * t]);
    }
    if (pts.length === 2) out.push([...pts[0], ...pts[1], level]);
    if (pts.length === 4) {
        // A saddle: which pairs join is decided by the middle of the cell.
        const mid = (c[0] + c[1] + c[2] + c[3]) / 4 - level;
        const up = (c[0] - level >= 0) === (mid >= 0);
        const [p, q] = up ? [[0, 3], [1, 2]] : [[0, 1], [2, 3]];
        out.push([...pts[p[0]], ...pts[p[1]], level]);
        out.push([...pts[q[0]], ...pts[q[1]], level]);
    }
}

// Which contours are bold: every fifth at 2 m, which is every 10 m.
export const boldAt = (level, every = 10) =>
    Math.abs(level / every - Math.round(level / every)) < 1e-6;
