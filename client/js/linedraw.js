// linedraw.js — the land's lines on the Blueprint clay, every frame: each as
// a band of its kind's width lying flat on the ground in its swatch, with its
// centre line; the one being drawn with its nodes and a rubber band to the
// pointer (PLAN-editors.md ideas 17 and 20). What is drawn is worked out once
// per change and kept on the line (`cache`).

import { drawMark, drawPath } from './bpdraw.js';
import { frameAt } from '../lib/spline.js';
import { curveOf } from './lines.js';

export function colourOf(pc, hex, k = 1) {
    const n = parseInt(String(hex ?? '#9aa4ad').slice(1), 16);
    return new pc.Color(((n >> 16) & 255) / 255 * k, ((n >> 8) & 255) / 255 * k,
        (n & 255) / 255 * k);
}

// The centre and both edges of a line's band, in degrees. `width` is the
// line's, or `widths` one per node (a handle was moved, EDT.15): each point
// of the curve takes the width of the node segment it is on, blended.
export function bandOf(line, width, widths = null) {
    const centre = curveOf(line);
    if (centre.length < 2) return { centre, left: [], right: [] };
    const f = frameAt(centre[0].lon, centre[0].lat);
    const at = widths ? widthAlong(line, centre.map((p) => f.toXZ(p.lon, p.lat)), f, widths)
        : null;
    // Offsets in metres straight off the curve's own degrees: a few metres
    // either side is flat enough, and a long road redrawn on every node is
    // thousands of points (client/test/feel.test.js).
    const [mLon, mLat] = [f.mLon, 110540];
    const left = [];
    const right = [];
    for (let i = 0; i < centre.length; i++) {
        const half = Math.max(0.1, (at ? at[i] : width) / 2);
        const a = centre[Math.max(0, i - 1)];
        const b = centre[Math.min(centre.length - 1, i + 1)];
        const dx = (b.lon - a.lon) * mLon;
        const dz = (a.lat - b.lat) * mLat;
        const d = Math.hypot(dx, dz) || 1;
        const ox = -dz / d * half;
        const oz = dx / d * half;
        const c = centre[i];
        left.push({ lon: c.lon + ox / mLon, lat: c.lat - oz / mLat });
        right.push({ lon: c.lon - ox / mLon, lat: c.lat + oz / mLat });
    }
    return { centre, left, right };
}

// Each curve point's width, blended between the nodes either side of it.
function widthAlong(line, xz, f, widths) {
    const nodes = line.nodes.map((n) => f.toXZ(n.lon, n.lat));
    return xz.map((p) => {
        let best = { d: Infinity, i: 0, t: 0 };
        for (let i = 0; i + 1 < nodes.length; i++) {
            const [a, b] = [nodes[i], nodes[i + 1]];
            const d2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 || 1;
            const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0])
                + (p[1] - a[1]) * (b[1] - a[1])) / d2));
            const d = Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1]));
            if (d < best.d) best = { d, i, t };
        }
        const next = widths[Math.min(widths.length - 1, best.i + 1)];
        return widths[best.i] * (1 - best.t) + next * best.t;
    });
}

function drawOne(bp, app, pc, line, { swatch, width, lit = false }) {
    if (line.nodes.length < 2) return;
    const own = line.props?.widths?.length === line.nodes.length ? line.props.widths.map(Number)
        : null;
    line.cache = line.cache ?? bandOf(line, Number(line.props?.width) || width || 2, own);
    const c = line.cache;
    const edge = colourOf(pc, swatch, lit ? 1 : 0.75);
    drawPath(bp, app, pc, c.left, edge, { step: 6 });
    drawPath(bp, app, pc, c.right, edge, { step: 6 });
    drawPath(bp, app, pc, c.centre, colourOf(pc, swatch, lit ? 1.2 : 1), { step: 6 });
}

/**
 * Everything Lines draws. `look(line)` answers the entry (swatch, width) a
 * line is drawn as; `selected` is lit; `ghosts` are neighbours', faint.
 */
export function drawLines(bp, app, pc, { lines, drawing, look, selected, at, ghosts = [],
    edges = [] }) {
    const faint = new pc.Color(0.42, 0.47, 0.5);
    for (const [a, b] of edges) {
        drawPath(bp, app, pc, [{ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] }], faint,
            { step: 8 });
    }
    for (const g of ghosts) {
        drawOne(bp, app, pc, g, { swatch: '#6d7780', width: Number(g.props?.width) || 2 });
    }
    for (const line of lines) {
        drawOne(bp, app, pc, line, { ...look(line), lit: line === selected });
    }
    if (selected) {
        for (const [i, n] of selected.nodes.entries()) {
            drawMark(bp, app, pc, n, selected.corner[i] ? new pc.Color(1, 0.6, 0.3)
                : new pc.Color(1, 1, 1), 1.2);
        }
    }
    if (!drawing) return;
    drawOne(bp, app, pc, drawing, { ...look(drawing), lit: true });
    for (const n of drawing.nodes) drawMark(bp, app, pc, n, new pc.Color(1, 1, 1), 1.2);
    const tail = drawing.nodes.at(-1);
    if (tail && at) drawPath(bp, app, pc, [tail, at], new pc.Color(0.8, 0.85, 0.9));
}
