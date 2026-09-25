// lineedit.js — editing a line on the clay (EDT.15, PLAN-editors.md ideas 18,
// 20 and 24).
//
// With Select in hand: click a line to take it; drag one of its nodes to move
// it (snapping as drawing does); drag the middle of a segment to put a node
// there; click a node twice to make it a corner or smooth again; Delete takes
// the node away (a line of one node goes altogether); the handle beside each
// node sets the width there. A right click on a node offers Split here, Join,
// Extend and Reverse. Every change is one step of the Lines undo.

import { frameAt, join, nearest, reverse, split } from '../lib/spline.js';
import { curveOf } from './lines.js';

const AGAIN_MS = 450;

// What is under the pointer, within `tol` metres: a width handle or a node of
// the selected line, or the curve of any line (and which node segment of it).
export function hitAt(lines, selected, g, tol) {
    const f = frameAt(g.lon, g.lat);
    const xz = (p) => f.toXZ(p.lon, p.lat);
    const here = xz(g);
    if (selected) {
        // The nearest of the selected line's nodes and handles, a node
        // winning a tie: a handle is half a road's width off its node.
        let near = null;
        const offer = (p, kind, i) => {
            const d = Math.hypot(...sub(xz(p), here));
            if (d <= tol && (!near || d < near.d - 1e-9)) near = { kind, line: selected, i, d };
        };
        selected.nodes.forEach((n, i) => offer(n, 'node', i));
        handlesOf(selected).forEach((h, i) => offer(h, 'handle', i));
        if (near) return near;
    }
    let best = null;
    for (const line of lines) {
        const n = nearest(curveOf(line).map(xz), here);
        if (n && n.d <= tol && (!best || n.d < best.d)) best = { kind: 'curve', line, d: n.d };
    }
    if (!best) return null;
    const seg = nearest(best.line.nodes.map(xz), here);
    return { ...best, i: seg?.i ?? 0 };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];

// The width handles: beside each node, half its width out to its left.
export function handlesOf(line) {
    const w = widthsOf(line);
    return line.nodes.map((n, i) => {
        const f = frameAt(n.lon, n.lat);
        const a = f.toXZ(line.nodes[Math.max(0, i - 1)].lon, line.nodes[Math.max(0, i - 1)].lat);
        const bNode = line.nodes[Math.min(line.nodes.length - 1, i + 1)];
        const b = f.toXZ(bNode.lon, bNode.lat);
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        // Left of the way the line runs, in a frame with z to the south.
        const nx = (b[1] - a[1]) / d;
        const nz = -(b[0] - a[0]) / d;
        return f.toLonLat([nx * w[i] / 2, nz * w[i] / 2]);
    });
}

// A line's width at each node: its own per-node widths if any handle was
// ever moved, the line's width otherwise.
export const widthsOf = (line) => line.nodes.map((_, i) =>
    Number(line.props?.widths?.[i] ?? line.props?.width ?? 2));

export function selectTool(state, acts) {
    let drag = null;
    let last = null;
    return {
        down(g, e) {
            if (!g) return;
            const hit = hitAt(state.lines.live, state.selected, g, acts.tol());
            if (!hit) { state.selected = null; state.node = null; acts.said(); return; }
            if (hit.line !== state.selected) {
                state.selected = hit.line;
                state.node = null;
                acts.said();
                return;
            }
            state.lines.remember();
            if (hit.kind === 'curve') {
                hit.line.nodes.splice(hit.i + 1, 0, { lon: g.lon, lat: g.lat });
                hit.line.corner.splice(hit.i + 1, 0, false);
                widen(hit.line, hit.i + 1);
                hit.i += 1;
            }
            drag = { hit, moved: false, x: e.clientX, y: e.clientY };
            state.node = hit.kind === 'handle' ? null : hit.i;
        },
        move(g, e) {
            if (!drag || !g) return;
            drag.moved = drag.moved || Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3;
            if (!drag.moved) return;
            const { line, i, kind } = drag.hit;
            if (kind === 'handle') setWidth(line, i, g);
            else moveNode(line, i, acts.snap(g, e));
            state.lines.changed(line);
        },
        up() {
            if (!drag) return;
            const { hit, moved } = drag;
            drag = null;
            if (moved) { acts.said(`${hit.line.kind} changed — Save to keep it`); return; }
            state.lines.past.pop();
            const again = last && last.i === hit.i && Date.now() - last.t < AGAIN_MS;
            last = { i: hit.i, t: Date.now() };
            if (again && hit.kind === 'node') toggle(state, hit.line, hit.i, acts);
            else acts.said();
        },
    };
}

function moveNode(line, i, at) {
    if (at.refused) return;
    line.nodes[i] = { lon: at.lon, lat: at.lat };
}

// The handle dragged: the width at node i is twice its distance from the node.
function setWidth(line, i, g) {
    const n = line.nodes[i];
    const [x, z] = frameAt(n.lon, n.lat).toXZ(g.lon, g.lat);
    const widths = widthsOf(line);
    widths[i] = Math.max(0.5, Math.round(Math.hypot(x, z) * 2 * 10) / 10);
    line.props = { ...line.props, widths };
}

// A node put in: its width, if the line has per-node widths, is its
// neighbours' mean.
function widen(line, i) {
    const w = line.props?.widths;
    if (!w) return;
    const at = (k) => Number(w[Math.max(0, Math.min(w.length - 1, k))]);
    w.splice(i, 0, (at(i - 1) + at(i)) / 2);
}

function toggle(state, line, i, acts) {
    state.lines.remember();
    line.corner[i] = !line.corner[i];
    state.lines.changed(line);
    acts.said(line.corner[i] ? 'a corner' : 'smooth');
}

// Delete: the node goes; a line of one node goes with it.
export function deleteNode(state, acts) {
    const line = state.selected;
    if (!line || state.node === null || state.node === undefined) return false;
    state.lines.remember();
    line.nodes.splice(state.node, 1);
    line.corner.splice(state.node, 1);
    if (line.props?.widths) line.props.widths.splice(state.node, 1);
    state.node = null;
    if (line.nodes.length < 2) {
        state.lines.past.pop();
        state.lines.remove(line);
        state.selected = null;
        acts.said('the line is gone — Save to keep it that way');
        return true;
    }
    state.lines.changed(line);
    acts.said('node taken out');
    return true;
}

// The node menu's four: they answer what they did, or null.
export const NODE_DEEDS = {
    split(state, line, i) {
        const got = split(line.nodes, line.corner, i);
        if (!got) return null;
        state.lines.remember();
        line.nodes = got[0].nodes;
        line.corner = got[0].corner;
        state.lines.changed(line);
        const widths = line.props?.widths;
        const other = { ...JSON.parse(JSON.stringify({ ...line, cache: null })),
            key: `${line.key}b`, id: null, state: 'new', nodes: got[1].nodes,
            corner: got[1].corner };
        if (widths) {
            line.props.widths = widths.slice(0, i + 1);
            other.props.widths = widths.slice(i);
        }
        state.lines.items.push(other);
        return 'split in two';
    },
    join(state, line, i) {
        const end = line.nodes[i];
        const f = frameAt(end.lon, end.lat);
        const d = (p) => Math.hypot(...f.toXZ(p.lon, p.lat));
        const other = state.lines.live.find((l) => l !== line && l.kind === line.kind
            && (d(l.nodes[0]) < 3 || d(l.nodes.at(-1)) < 3));
        if (!other) return null;
        const xz = (l) => ({ nodes: l.nodes.map((n) => [n.lon, n.lat]), corner: l.corner });
        const got = join(xz(line), xz(other), 1e-4);
        if (!got) return null;
        state.lines.remember();
        line.nodes = got.nodes.map(([lon, lat]) => ({ lon, lat }));
        line.corner = got.corner;
        state.lines.changed(line);
        state.lines.items = state.lines.items.filter((l) => l !== other || l.id);
        if (other.id) other.state = 'deleted';
        return 'joined into one';
    },
    reverse(state, line) {
        state.lines.remember();
        const r = reverse({ nodes: line.nodes, corner: line.corner });
        line.nodes = r.nodes;
        line.corner = r.corner;
        if (line.props?.widths) line.props.widths.reverse();
        state.lines.changed(line);
        return 'reversed';
    },
    // Extend: the line becomes the one being drawn, from this end.
    extend(state, line, i) {
        if (i !== 0 && i !== line.nodes.length - 1) return null;
        state.lines.remember();
        if (i === 0) NODE_DEEDS.reverse(state, line);
        state.lines.items = state.lines.items.filter((l) => l !== line || l.id);
        if (line.id) line.state = 'deleted';
        state.drawing = { ...line, key: `${line.key}x`, id: null, state: 'new', cache: null,
            nodes: [...line.nodes], corner: [...line.corner] };
        state.selected = null;
        return 'drawing on from its end';
    },
};
