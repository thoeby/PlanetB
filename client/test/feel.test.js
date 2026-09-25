// EDT.25 — the feel gate: what a frame of shaping and a node of a line cost
// in the page's own code, on a land of four square kilometres.
//
// A three-second Raise stroke, sixty frames a second: every frame is one dab
// on the land's grid, the clay's heights read again under the brush, and the
// chunks the brush touched built again — exactly the work Blueprint.rebuild
// does in the tab (client/js/blueprint.js), less the upload to the GPU. The
// 95th-percentile frame has to leave room in 16.7 ms, and a frame may only
// rebuild the few chunks under the brush, never the land.
//
// Then a forty-node road: every node is snapped (client/js/linesnap.js) and
// the band drawn along the whole curve again (client/js/linedraw.js), under
// 4 ms a node.
//
// Measured on the CPU, not the GPU: this runs everywhere, with or without an
// adapter. What it proves is that the script never makes a frame late.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Shaping, cellFor } from '../js/sculpt.js';
import { dab } from '../js/sculptbrush.js';
import { gridFor } from '../lib/r32.js';
import { chunkGeometry, chunksIn, chunksOf, indexOf, latAt, layout, lonAt }
    from '../lib/bpgrid.js';
import { linear, vertexColour } from '../lib/clay.js';
import { lineOf } from '../js/lines.js';
import { bandOf } from '../js/linedraw.js';
import { snapNode } from '../js/linesnap.js';

const LAT0 = 46.28;
const LON0 = 7.86;
const SIDE_M = 2000;
const mLon = 111320 * Math.cos((LAT0 + 0.009) * Math.PI / 180);
const E = LON0 + SIDE_M / mLon;
const N = LAT0 + SIDE_M / 110540;
const AREA = { id: 'feel', bbox: { west: LON0, south: LAT0, east: E, north: N },
    outline: { type: 'Polygon', coordinates: [[[LON0, LAT0], [E, LAT0], [E, N], [LON0, N],
        [LON0, LAT0]]] } };

const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];

// The clay over the land: heights of a gentle hill, as Blueprint holds them.
function clay(shaping) {
    const L = layout([LON0, LAT0, E, N], shaping.grid.cell);
    const n = L.cols * L.rows;
    const base = new Float32Array(n);
    for (let j = 0; j < L.rows; j++) {
        for (let i = 0; i < L.cols; i++) {
            base[j * L.cols + i] = 600 + 40 * Math.sin(i / 90) * Math.cos(j / 70);
        }
    }
    return { L, base, heights: Float32Array.from(base), chunks: chunksOf(L) };
}

// One frame of Blueprint.rebuild(rect): resample under the brush, then build
// the chunks it touches.
function rebuild(c, shaping, rect) {
    const { L } = c;
    const a = indexOf(L, rect[0], rect[3]);
    const b = indexOf(L, rect[2], rect[1]);
    const [i0, j0, i1, j1] = [Math.floor(a.i) - 1, Math.floor(a.j) - 1, Math.ceil(b.i) + 1,
        Math.ceil(b.j) + 1];
    for (let j = Math.max(0, j0); j <= Math.min(L.rows - 1, j1); j++) {
        for (let i = Math.max(0, i0); i <= Math.min(L.cols - 1, i1); i++) {
            const k = j * L.cols + i;
            c.heights[k] = c.base[k] + shaping.at(lonAt(L, i), latAt(L, j));
        }
    }
    const colour = (k, i, j, slope, lit) => linear(vertexColour({ slope, lit, i, j,
        inside: true, delta: 0, unsaved: false, changed: true, steep: 0 }));
    const built = chunksIn(c.chunks, i0 - 1, j0 - 1, i1 + 1, j1 + 1);
    let vertices = 0;
    for (const ch of built) {
        vertices += chunkGeometry(L, c.heights, ch, colour, { h0: 600, skirt: 2 })
            .positions.length / 3;
    }
    return { chunks: built.length, vertices };
}

test('a three-second Raise on four square kilometres keeps every frame short', () => {
    const shaping = new Shaping(AREA, gridFor([LON0, LAT0, E, N], cellFor(AREA.bbox)));
    const c = clay(shaping);
    const size = 30;
    const how = { brush: 'raise', size, strength: 2, dt: 1 / 60, soft: 0.6, curve: 'smooth',
        shape: 'circle', blend: true, limit: { up: 8, down: 8 } };
    const ms = [];
    const most = { chunks: 0, vertices: 0 };
    shaping.begin({ brush: 'raise', size });
    for (let f = 0; f < 180; f++) {
        const lon = LON0 + (400 + f * 4) / mLon;
        const lat = LAT0 + (900 + 200 * Math.sin(f / 30)) / 110540;
        const t = performance.now();
        dab(shaping, lon, lat, how);
        const r = size / 2;
        const got = rebuild(c, shaping, [lon - r / mLon, lat - r / 110540, lon + r / mLon,
            lat + r / 110540]);
        ms.push(performance.now() - t);
        most.chunks = Math.max(most.chunks, got.chunks);
        most.vertices = Math.max(most.vertices, got.vertices);
    }
    shaping.end();
    const whole = c.chunks.length;
    assert.ok(p95(ms) < 16.7, `p95 frame ${p95(ms).toFixed(2)} ms`);
    assert.ok(most.chunks <= 4, `${most.chunks} of ${whole} chunks rebuilt in one frame`);
    assert.ok(most.vertices <= 4 * 70 * 70, `${most.vertices} vertices in one frame`);
});

test('a forty-node road costs under 4 ms a node', () => {
    const shaping = new Shaping(AREA, gridFor([LON0, LAT0, E, N], cellFor(AREA.bbox)));
    // Twenty lines already on the land, whose ends a node may snap to.
    const live = [];
    for (let n = 0; n < 20; n++) {
        const nodes = [];
        for (let k = 0; k < 8; k++) {
            nodes.push({ lon: LON0 + (100 + n * 90) / mLon, lat: LAT0 + (100 + k * 60) / 110540 });
        }
        live.push(lineOf({ kind: 'highway', nodes, corner: nodes.map(() => false) }));
    }
    const state = { lines: { area: { ...AREA, rings: shaping.rings }, live }, ghosts: [],
        edges: [], drawing: lineOf({ kind: 'highway', nodes: [], corner: [] }) };
    const ms = [];
    for (let n = 0; n < 40; n++) {
        const g = { lon: LON0 + (150 + n * 40) / mLon,
            lat: LAT0 + (1200 + 80 * Math.sin(n / 4)) / 110540 };
        // The best of three: node --test runs the files side by side, and
        // what is measured is this code, not its neighbours.
        let best = Infinity;
        for (let r = 0; r < 3; r++) {
            const t = performance.now();
            const at = snapNode(state, g, { shiftKey: false, altKey: false });
            if (r === 0) {
                state.drawing.nodes.push({ lon: at.lon, lat: at.lat });
                state.drawing.corner.push(false);
            }
            bandOf(state.drawing, 5);
            best = Math.min(best, performance.now() - t);
        }
        ms.push(best);
    }
    const mean = ms.reduce((s, x) => s + x, 0) / ms.length;
    assert.ok(mean < 4, `mean ${mean.toFixed(2)} ms a node`);
    assert.ok(p95(ms) < 4, `p95 ${p95(ms).toFixed(2)} ms a node`);
});
