// snap.js — where a node of a line lands (EDT.14, PLAN-editors.md idea 19
// and D5): on a line's end, on the land's boundary, on an area's edge, at a
// 15° step from the last node while Ctrl is held, or on the metre grid when
// the grid is on — whichever is nearest in that order of importance, within a
// few pixels' worth of metres. Every snap says in two words what it hit.
//
// And the boundary rule: a node off the land is pulled onto its boundary when
// it is near it, and refused when it is further in somebody else's ground.
//
// Pure, in a metric frame (x east, z south). Node-tested (client/test/snap.test.js).

import { toSegment } from './spline.js';
import { contains } from './poly.js';

// What a line's end is called on the tag, by kind.
const END_WORDS = { highway: 'road end', waterway: 'stream end', barrier: 'wall end',
    railway: 'rail end', aerialway: 'cable end' };
export const endWords = (kind) => END_WORDS[kind] ?? 'line end';

// How far off its boundary a node may be dropped and still be pulled onto it.
export const PULL_M = 30;

const nearestOnRings = (p, rings) => {
    let best = null;
    for (const ring of rings) {
        for (let i = 0; i + 1 < ring.length; i++) {
            const s = toSegment(p, ring[i], ring[i + 1]);
            if (!best || s.d < best.d) best = s;
        }
    }
    return best;
};

/**
 * `p` is the point [x, z]; `on` is {ends: [{p, kind}], land: rings,
 * edges: [[a, b]], prev: [x, z] | null, angle: Ctrl held, grid: metres or 0,
 * tol: metres}. Answers {p, hit} — `hit` null for no snap — or {refused}.
 */
export function snapPoint(p, on) {
    const tol = on.tol ?? 2;
    const inside = !on.land?.length || contains(on.land, p[0], p[1]);
    let best = null;
    const offer = (q, d, hit) => {
        if (d <= tol && (!best || d < best.d)) best = { p: q, d, hit };
    };
    for (const e of on.ends ?? []) {
        offer(e.p, Math.hypot(e.p[0] - p[0], e.p[1] - p[1]), endWords(e.kind));
    }
    if (best) return { p: best.p, hit: best.hit };
    const edge = on.land?.length ? nearestOnRings(p, on.land) : null;
    if (!inside) {
        if (edge && edge.d <= PULL_M) return { p: edge.foot, hit: 'boundary' };
        return { refused: true, p };
    }
    if (edge) offer(edge.foot, edge.d, 'boundary');
    for (const [a, b] of on.edges ?? []) {
        const s = toSegment(p, a, b);
        offer(s.foot, s.d, 'area edge');
    }
    if (best) return { p: best.p, hit: best.hit };
    if (on.angle && on.prev) return { p: stepped(on.prev, p), hit: '15°' };
    if (on.grid > 0) {
        const g = on.grid;
        return { p: [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g], hit: 'grid' };
    }
    return { p, hit: null };
}

// The point at the same distance from `prev`, turned to the nearest 15°.
export function stepped(prev, p) {
    const dx = p[0] - prev[0];
    const dz = p[1] - prev[1];
    const r = Math.hypot(dx, dz);
    const a = Math.round(Math.atan2(dz, dx) / (Math.PI / 12)) * (Math.PI / 12);
    return [prev[0] + Math.cos(a) * r, prev[1] + Math.sin(a) * r];
}
