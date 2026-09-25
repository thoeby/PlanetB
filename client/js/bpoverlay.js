// bpoverlay.js — what Blueprint draws on the clay besides the clay: contour
// lines every 2 m (bold every 10), a metric grid (5, 25 or 100 m as the camera
// is near or far, bold every fifth line), and the card
// that picks how the clay is seen (PLAN-editors.md §2.1; EDT.2).
//
// Three views, as a modelling tool has (the operator's note): Solid, the lit
// clay and nothing on it; Contours, flat clay with its height lines; Grid, the
// lit clay with a metric grid. Z steps through them. Two switches stay beside
// them: what you changed as colour, and the neighbours' lines.
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
const GRID = linear([0.62, 0.62, 0.6]);
const GRID_BOLD = linear([0.36, 0.36, 0.35]);

// The grid's cell for a camera this far off: a cell stays a handful of
// pixels wide, never a grey wash.
export const gridStep = (distance) => (distance < 300 ? GRID_M : distance < 1500 ? 25 : 100);

const KEY = 'splatworld.blueprint.overlays';

export const VIEWS = [
    { id: 'solid', words: 'Solid', sets: { contours: false, grid: false, flat: false } },
    { id: 'contours', words: 'Contours', sets: { contours: true, grid: false, flat: true } },
    { id: 'grid', words: 'Grid', sets: { contours: false, grid: true, flat: false } },
];

export const SWITCHES = [
    { key: 'changed', words: 'What you changed, as colour' },
    { key: 'neighbours', words: "Neighbours' lines and areas" },
];

// The overlays as the view in them says: a view decides the lines and the
// shading, whatever was stored before views existed.
export function viewed(o) {
    const v = VIEWS.find((x) => x.id === o.view) ?? VIEWS[0];
    return { ...o, view: v.id, ...v.sets, steep: false };
}

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
        for (const s of isolines(eased(L, heights, c), c.i0, c.j0, c.i1, c.j1,
            bp.far ? BOLD_M : CONTOUR_M)) segs.push([s, boldAt(s[4], BOLD_M) ? BOLD : FINE]);
    }
    if (o.grid) {
        const east = (i) => (lonAt(L, i) - L.lon0) * L.mLon;
        const south = (_i, j) => (L.lat0 - latAt(L, j)) * L.mLat;
        // As fine as the camera's distance allows (gridStep), bold every five.
        const every = bp.gridM ?? GRID_M;
        for (const f of [east, south]) {
            for (const s of isolines(f, c.i0, c.j0, c.i1, c.j1, every)) {
                segs.push([s, boldAt(s[4], every * 5) ? GRID_BOLD : GRID]);
            }
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

// The heights a contour is traced through: averaged over about four metres
// each way (a separable box over the chunk and a margin), so a surface model's
// hedges and roofs on a flat valley floor are not drawn as a field of rings.
export function eased(L, h, c, metres = 4) {
    const r = Math.max(1, Math.min(6, Math.round(metres / L.step)));
    const i0 = Math.max(0, c.i0 - r);
    const j0 = Math.max(0, c.j0 - r);
    const i1 = Math.min(L.cols - 1, c.i1 + r);
    const j1 = Math.min(L.rows - 1, c.j1 + r);
    const w = i1 - i0 + 1;
    const rows = j1 - j0 + 1;
    const across = new Float32Array(w * rows);
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < w; i++) {
            let sum = 0;
            let n = 0;
            for (let d = -r; d <= r; d++) {
                const x = i + d;
                if (x < 0 || x >= w) continue;
                sum += h[(j0 + j) * L.cols + i0 + x];
                n += 1;
            }
            across[j * w + i] = sum / n;
        }
    }
    return (i, j) => {
        let sum = 0;
        let n = 0;
        for (let d = -r; d <= r; d++) {
            const y = j - j0 + d;
            if (y < 0 || y >= rows) continue;
            sum += across[y * w + (i - i0)];
            n += 1;
        }
        return sum / n;
    };
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
        return viewed({ ...defaults,
            ...JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}') });
    } catch {
        return viewed({ ...defaults });
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

// A view picked: the lines and the shading both change, so every chunk.
export function setView(bp, id) {
    Object.assign(bp.overlays, viewed({ ...bp.overlays, view: id }));
    remember(bp.overlays);
    bp.repaint();
    bp.tell?.(null);
}

const cycle = (bp) => {
    const at = VIEWS.findIndex((v) => v.id === bp.overlays.view);
    setView(bp, VIEWS[(at + 1) % VIEWS.length].id);
};

// The card: the three views as one row, and a switch a row under them.
export function overlayCard(bp) {
    const views = VIEWS.map((v) => {
        const b = el('button', { type: 'button', className: `bp-shade bp-shade-${v.id}`,
            textContent: v.words });
        b.onclick = () => { setView(bp, v.id); mark(); };
        return b;
    });
    const mark = () => {
        for (const [n, b] of views.entries()) {
            b.setAttribute('aria-pressed', String(VIEWS[n].id === bp.overlays.view));
        }
    };
    mark();
    // Z steps through them while the clay is up; Ctrl-Z is undo, not this.
    window.addEventListener('keydown', (e) => {
        if (!bp.active || e.ctrlKey || e.metaKey || e.altKey || e.code !== 'KeyZ') return;
        if (e.target?.closest?.('input, select, textarea, [contenteditable]')) return;
        cycle(bp);
        mark();
    });
    const rows = SWITCHES.map((s) => {
        const box = el('input', { type: 'checkbox', className: `bp-sw bp-sw-${s.key}` });
        box.checked = Boolean(bp.overlays[s.key]);
        box.onchange = () => setOverlay(bp, s.key, box.checked);
        return el('label', { className: 'bp-row' }, el('span', { className: 'bp-words' },
            el('span', { textContent: s.words })), box);
    });
    return el('div', { className: 'bp-card' },
        el('div', { className: 'label caps', textContent: 'View · Z' }),
        el('div', { className: 'bp-shades' }, ...views), ...rows);
}
