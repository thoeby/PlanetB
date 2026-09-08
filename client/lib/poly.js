// poly.js — the polygon maths `assemble` needs, in the tile's own frame
// (x east, z south, metres). Points are [x, z] pairs.
//
// Everything here is deterministic: no Math.random, no iteration over a Map or
// a Set, no floating-point reduction whose order could change (Invariant 2).

export const ringArea = (pts) => {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    }
    return a / 2;
};

export function bbox(rings) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const ring of rings) {
        for (const [x, z] of ring) {
            b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], z);
            b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], z);
        }
    }
    return b;
}

// Even-odd, holes included: a point inside a hole is outside the polygon.
export function contains(rings, x, z) {
    let inside = false;
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, zi] = ring[i];
            const [xj, zj] = ring[j];
            if ((zi > z) !== (zj > z)
                && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
        }
    }
    return inside;
}

// ------------------------------------------------------------- triangulation

const cross = (a, b, c) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function inTriangle(a, b, c, p) {
    const d1 = cross(a, b, p);
    const d2 = cross(b, c, p);
    const d3 = cross(c, a, p);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

// Ear clipping over one simple ring — the outer ring of a footprint or a water
// body. Holes are not cut: a courtyard is filled in, which is visible only from
// above and is the price of a triangulator that fits on a page.
export function earcut(pts) {
    const n = pts.length;
    if (n < 3) return [];
    // Ear clipping wants the winding whose cross product is positive here;
    // ringArea is negative for exactly that one in this x/z frame.
    const idx = [...Array(n).keys()];
    if (ringArea(pts) > 0) idx.reverse();
    const out = [];
    let guard = n * n;
    while (idx.length > 3 && guard-- > 0) {
        let clipped = false;
        for (let i = 0; i < idx.length; i++) {
            const a = idx[(i + idx.length - 1) % idx.length];
            const b = idx[i];
            const c = idx[(i + 1) % idx.length];
            if (cross(pts[a], pts[b], pts[c]) <= 0) continue;
            const bad = idx.some((k) => k !== a && k !== b && k !== c
                && inTriangle(pts[a], pts[b], pts[c], pts[k]));
            if (bad) continue;
            out.push(a, b, c);
            idx.splice(i, 1);
            clipped = true;
            break;
        }
        if (!clipped) break;          // self-intersecting: keep what was cut
    }
    if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
    return out;
}

// ------------------------------------------------------------------- scatter

// mulberry32, the same generator tools/testterrain.mjs uses: the same seed
// gives the same world on every machine.
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Poisson-disk by jittered grid: one candidate per cell, kept if it is inside
// the polygon and no nearer than `radius` to one already kept. Cells are walked
// in a fixed order, so the same seed lays out the same trees.
export function scatter(rings, radius, random) {
    const [x0, z0, x1, z1] = bbox(rings);
    const cell = radius / Math.SQRT2;
    const cols = Math.max(1, Math.ceil((x1 - x0) / cell));
    const rows = Math.max(1, Math.ceil((z1 - z0) / cell));
    const grid = new Map();
    const out = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const x = x0 + (c + random()) * cell;
            const z = z0 + (r + random()) * cell;
            if (x > x1 || z > z1 || !contains(rings, x, z)) continue;
            let ok = true;
            for (let dr = -2; dr <= 2 && ok; dr++) {
                for (let dc = -2; dc <= 2 && ok; dc++) {
                    const p = grid.get(`${r + dr}:${c + dc}`);
                    if (p && Math.hypot(p[0] - x, p[1] - z) < radius) ok = false;
                }
            }
            if (!ok) continue;
            grid.set(`${r}:${c}`, [x, z]);
            out.push([x, z]);
        }
    }
    return out;
}
