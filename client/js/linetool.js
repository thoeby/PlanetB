// linetool.js — drawing a line on the Blueprint clay (EDT.13, PLAN-editors.md
// idea 17): click places a node, a held drag sketches and is simplified on
// release, Enter or a second click on the last node ends it, Esc drops the
// last node. The line is drawn as it will be — a band of its kind's width
// lying flat on the ground — before anything is saved or compiled.

import { frameAt, simplify } from '../lib/spline.js';
import { lineOf } from './lines.js';

// How far the pointer has to travel with the button down to be a sketch
// rather than a click, in pixels; and how close a second click has to be to
// the last node, in pixels and milliseconds, to end the line.
const SKETCH_PX = 8;
const AGAIN_PX = 6;
const AGAIN_MS = 450;

export function drawTool(state, acts) {
    let press = null;
    let last = null;
    return {
        down(g, e) {
            if (!g) { acts.say('no ground under the pointer', true); return; }
            press = { g, x: e.clientX, y: e.clientY, sketch: [g], sketching: false };
        },
        move(g, e) {
            if (!press || !g) return;
            const far = Math.hypot(e.clientX - press.x, e.clientY - press.y) > SKETCH_PX;
            if (far) press.sketching = true;
            if (press.sketching) press.sketch.push(g);
        },
        up(g, e) {
            if (!press) return;
            const was = press;
            press = null;
            if (was.sketching) { addNodes(state, acts, sketched(was.sketch)); return; }
            const again = last && Date.now() - last.t < AGAIN_MS
                && Math.hypot(e.clientX - last.x, e.clientY - last.y) < AGAIN_PX;
            last = { t: Date.now(), x: e.clientX, y: e.clientY };
            if (again) { acts.finish(); return; }
            addNodes(state, acts, [was.g]);
        },
        sketch: () => press?.sketching ? press.sketch : null,
    };
}

// A sketch's points, simplified to the nodes that stay within half a metre.
function sketched(points) {
    const f = frameAt(points[0].lon, points[0].lat);
    return simplify(points.map((p) => f.toXZ(p.lon, p.lat)), 0.5).map(f.toLonLat);
}

// Nodes onto the line being drawn, starting one if none is.
function addNodes(state, acts, nodes) {
    const entry = acts.entry();
    if (!entry) { acts.say('pick a kind first', true); return; }
    if (!state.drawing) {
        state.drawing = lineOf({ kind: entry.kind, props: { ...entry.props, width: entry.width },
            nodes: [], corner: [], entry });
    }
    for (const n of nodes) {
        state.drawing.nodes.push({ lon: n.lon, lat: n.lat });
        state.drawing.corner.push(Boolean(entry.corner));
    }
    state.drawing.cache = null;
    const n = state.drawing.nodes.length;
    acts.say(`${n} node${n === 1 ? '' : 's'} — Enter or click the last again to end,`
        + ' Esc drops the last');
}

// Esc: the last node goes; a line of none is no line.
export function dropLast(state, say) {
    const d = state.drawing;
    if (!d?.nodes.length) return false;
    d.nodes.pop();
    d.corner.pop();
    d.cache = null;
    if (!d.nodes.length) state.drawing = null;
    say(d.nodes.length ? `${d.nodes.length} node(s)` : 'nothing being drawn');
    return true;
}
