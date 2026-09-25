// bpoverlay.js — what Blueprint draws on the clay besides the clay: contour
// lines every 2 m (bold every 10), the 5 m grid, and the card of switches
// that turn those and the colours on and off (PLAN-editors.md §2.1; EDT.2).
//
// The lines are built per chunk with the chunk (client/js/blueprint.js
// buildChunk), so a stroke redraws the contours it moved and no others. The
// switches are remembered per player in this browser.

import { heightIn, latAt, local, lonAt } from '../lib/bpgrid.js';
import { boldAt, isolines } from '../lib/contour.js';
import { linear } from '../lib/clay.js';
import { el } from './tabbar.js';

export const CONTOUR_M = 2;
export const BOLD_M = 10;
export const GRID_M = 5;
// Lines stand this far off the clay so they are not buried in it.
const LIFT_M = 0.12;

const FINE = linear([0.5, 0.5, 0.48]);
const BOLD = linear([0.2, 0.2, 0.19]);
const GRID = linear([0.3, 0.52, 0.72]);

const KEY = 'splatworld.blueprint.overlays';

export const SWITCHES = [
    { key: 'contours', words: 'Contour lines · 2 m' },
    { key: 'changed', words: 'What you changed, as colour' },
    { key: 'grid', words: 'Grid · 5 m' },
    { key: 'steep', words: 'Slopes above', number: 'steepAt' },
    { key: 'neighbours', words: "Neighbours' lines and areas" },
];

// Which switches repaint the clay and which redraw the lines.
const PAINTS = new Set(['changed', 'steep', 'steepAt']);
const LINES = new Set(['contours', 'grid']);

/**
 * The segments one chunk draws, as positions and colours for a line mesh, or
 * null for none.
 */
export function chunkLines(bp, c) {
    const { L, heights, overlays: o } = bp;
    const segs = [];
    if (o.contours) {
        for (const s of isolines(eased(L, heights), c.i0, c.j0, c.i1, c.j1,
            CONTOUR_M)) segs.push([s, boldAt(s[4], BOLD_M) ? BOLD : FINE]);
    }
    if (o.grid) {
        const east = (i) => (lonAt(L, i) - L.lon0) * L.mLon;
        const south = (_i, j) => (L.lat0 - latAt(L, j)) * L.mLat;
        for (const f of [east, south]) {
            for (const s of isolines(f, c.i0, c.j0, c.i1, c.j1, GRID_M)) segs.push([s, GRID]);
        }
    }
    if (!segs.length) return null;
    const positions = new Float32Array(segs.length * 6);
    const colors = new Float32Array(segs.length * 6);
    segs.forEach(([s, colour], n) => {
        for (let e = 0; e < 2; e++) {
            const fi = s[e * 2];
            const fj = s[e * 2 + 1];
            const p = local(L, lonAt(L, fi), latAt(L, fj),
                heightIn(L, heights, fi, fj) + LIFT_M, bp.h0);
            positions.set([p.x, p.y, p.z], n * 6 + e * 3);
            colors.set(colour, n * 6 + e * 3);
        }
    });
    return { positions, colors };
}

// The heights a contour is traced through: each with its four neighbours, so
// a survey's centimetre noise on a flat valley floor is not drawn as a field
// of two-metre rings.
function eased(L, h) {
    const at = (i, j) => h[Math.min(L.rows - 1, Math.max(0, j)) * L.cols
        + Math.min(L.cols - 1, Math.max(0, i))];
    return (i, j) => (at(i, j) * 4 + at(i - 1, j) + at(i + 1, j) + at(i, j - 1)
        + at(i, j + 1)) / 8;
}

// The line mesh of one chunk, built again with it; gone when it has none.
export function drawChunkLines(bp, one) {
    const got = chunkLines(bp, one.chunk);
    if (!got) {
        one.lines?.destroy();
        one.lines = null;
        return;
    }
    const { pc } = bp;
    const mesh = new pc.Mesh(bp.app.graphicsDevice);
    mesh.setPositions(got.positions);
    mesh.setColors(got.colors, 3);
    mesh.update(pc.PRIMITIVE_LINES);
    one.lines?.destroy();
    one.lines = new pc.Entity(`blueprint lines ${one.chunk.key}`);
    one.lines.addComponent('render', {
        meshInstances: [new pc.MeshInstance(mesh, lineMaterial(bp))],
        castShadows: false, receiveShadows: false,
    });
    bp.root.addChild(one.lines);
}

function lineMaterial(bp) {
    if (bp.lineMat) return bp.lineMat;
    const m = new bp.pc.StandardMaterial();
    m.useLighting = false;
    m.diffuse = new bp.pc.Color(0, 0, 0);
    m.emissive = new bp.pc.Color(1, 1, 1);
    m.emissiveVertexColor = true;
    m.update();
    bp.lineMat = m;
    return m;
}

// What the switches were left at, in this browser. Storage that is not there
// (a private window) is the defaults, not an error.
export function remembered(defaults) {
    try {
        return { ...defaults, ...JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}') };
    } catch {
        return { ...defaults };
    }
}

function remember(overlays) {
    try {
        globalThis.localStorage?.setItem(KEY, JSON.stringify(overlays));
    } catch { /* nothing to keep it in */ }
}

// What a switch changes: the clay's colours, the lines, or only whoever draws
// on top (the neighbours' ghosts listen for the change).
export function setOverlay(bp, key, value) {
    bp.overlays[key] = value;
    remember(bp.overlays);
    if (!bp.active) return;
    if (PAINTS.has(key)) bp.repaint();
    else if (LINES.has(key)) bp.relines();
    else bp.tell(null);
}

// The card: one switch a row, the number beside the slope one.
export function overlayCard(bp) {
    const rows = SWITCHES.map((s) => {
        const box = el('input', { type: 'checkbox', className: `bp-sw bp-sw-${s.key}` });
        box.checked = Boolean(bp.overlays[s.key]);
        box.onchange = () => setOverlay(bp, s.key, box.checked);
        const bits = [el('span', { textContent: s.words })];
        if (s.number) {
            const n = el('input', { type: 'number', className: `bp-num bp-num-${s.number}`,
                min: '5', max: '80', step: '1', value: String(bp.overlays[s.number]) });
            n.onchange = () => setOverlay(bp, s.number, Math.max(5, Number(n.value) || 35));
            bits.push(n, el('span', { textContent: '°' }));
        }
        return el('label', { className: 'bp-row' }, el('span', { className: 'bp-words' },
            ...bits), box);
    });
    return el('div', { className: 'bp-card' },
        el('div', { className: 'label caps', textContent: 'On the ground' }), ...rows);
}
