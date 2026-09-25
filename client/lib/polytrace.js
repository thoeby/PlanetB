// polytrace.js — a grid of filled cells back into polygons (EDT.20): marching
// squares over the cell centres, the segments linked into closed rings, each
// ring simplified, and the rings nested into outers and holes by what
// contains what. The raster half of client/lib/polyops.js.

import { ringArea } from './polyops.js';
import { simplify } from './spline.js';

// For each of the sixteen corner codes (a b c d = top-left, top-right,
// bottom-right, bottom-left), the edges each segment joins. The two saddles
// keep the filled corners apart.
const CASES = [[], [['l', 'b']], [['b', 'r']], [['l', 'r']], [['t', 'r']],
    [['t', 'r'], ['l', 'b']], [['t', 'b']], [['l', 't']], [['l', 't']], [['t', 'b']],
    [['l', 't'], ['b', 'r']], [['t', 'r']], [['l', 'r']], [['b', 'r']], [['l', 'b']], []];

// An edge's key and its midpoint.
function edge(g, i, j, which) {
    if (which === 't') return [`h${i},${j}`, [g.x0 + (i + 1) * g.cell, g.z0 + (j + 0.5) * g.cell]];
    if (which === 'b') {
        return [`h${i},${j + 1}`, [g.x0 + (i + 1) * g.cell, g.z0 + (j + 1.5) * g.cell]];
    }
    if (which === 'l') return [`v${i},${j}`, [g.x0 + (i + 0.5) * g.cell, g.z0 + (j + 1) * g.cell]];
    return [`v${i + 1},${j}`, [g.x0 + (i + 1.5) * g.cell, g.z0 + (j + 1) * g.cell]];
}

function segments(mask, g) {
    const at = new Map();
    const pts = new Map();
    const link = (a, b) => {
        for (const [x, y] of [[a, b], [b, a]]) {
            if (!at.has(x[0])) at.set(x[0], []);
            at.get(x[0]).push(y[0]);
            pts.set(x[0], x[1]);
        }
    };
    const v = (i, j) => mask[j * g.cols + i];
    for (let j = 0; j + 1 < g.rows; j++) {
        for (let i = 0; i + 1 < g.cols; i++) {
            const code = v(i, j) * 8 + v(i + 1, j) * 4 + v(i + 1, j + 1) * 2 + v(i, j + 1);
            for (const [p, q] of CASES[code]) link(edge(g, i, j, p), edge(g, i, j, q));
        }
    }
    return { at, pts };
}

function rings(mask, g) {
    const { at, pts } = segments(mask, g);
    const seen = new Set();
    const out = [];
    for (const start of at.keys()) {
        if (seen.has(start)) continue;
        const ring = [];
        let prev = null;
        let key = start;
        while (key && !seen.has(key)) {
            seen.add(key);
            ring.push(pts.get(key));
            const next = at.get(key).find((k) => k !== prev && !seen.has(k));
            prev = key;
            key = next;
        }
        if (ring.length >= 3) out.push(ring);
    }
    return out;
}

// A closed ring simplified: split at its farthest point from its first, and
// each half simplified as a line.
function simplifyRing(ring, tol) {
    let far = 0;
    let at = 0;
    ring.forEach((p, k) => {
        const d = Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]);
        if (d > far) { far = d; at = k; }
    });
    const a = simplify(ring.slice(0, at + 1), tol);
    const b = simplify([...ring.slice(at), ring[0]], tol);
    const out = [...a, ...b.slice(1, -1)];
    return out.length >= 3 ? out : ring;
}

const inside = (ring, [x, z]) => {
    let on = false;
    for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const [ax, az] = ring[k];
        const [bx, bz] = ring[i];
        if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) on = !on;
    }
    return on;
};

/** The filled cells of `mask` over grid `g` as polygons, rings simplified to `tol`. */
export function traceMask(mask, g, tol) {
    const all = rings(mask, g).map((r) => ({ raw: r, ring: simplifyRing(r, tol),
        area: Math.abs(ringArea(r)) })).filter((r) => r.area > g.cell * g.cell * 0.5);
    all.sort((p, q) => q.area - p.area);
    const polys = [];
    for (let n = 0; n < all.length; n++) {
        const me = all[n];
        let parent = null;
        for (let m = n - 1; m >= 0; m--) {
            if (inside(all[m].raw, me.raw[0])) { parent = all[m]; break; }
        }
        me.depth = parent ? parent.depth + 1 : 0;
        if (me.depth % 2 === 0) {
            me.poly = [me.ring];
            polys.push(me.poly);
        } else {
            parent.poly.push(me.ring);
        }
    }
    return polys;
}
