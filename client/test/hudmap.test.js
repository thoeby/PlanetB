// The map in the corner: what span holds the land it has to draw.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drawMinimap, drawWhere, hillshade, SPANS, spanFor } from '../js/hudmap.js';
import { tileCenter } from '../lib/tilemath.js';

const at = { lon: 9.69, lat: 46.4 };

test('with no land to draw the map keeps its default span', () => {
    assert.equal(spanFor([], at), 500);
    assert.equal(spanFor(undefined, at), 500);
});

test('an area arrives as a bbox or as a ring, and both are held', () => {
    const box = spanFor([{ bbox: [9.688, 46.399, 9.692, 46.401] }], at);
    const ring = spanFor([{ ring: [[9.688, 46.399], [9.692, 46.399],
        [9.692, 46.401], [9.688, 46.401]] }], at);
    assert.equal(box, ring);
    assert.ok(SPANS.includes(box));
});

test('land further away widens the map until it fits', () => {
    const near = spanFor([{ bbox: [9.688, 46.399, 9.692, 46.401] }], at);
    const far = spanFor([{ bbox: [9.60, 46.34, 9.62, 46.36] }], at);
    assert.ok(far > near, `${far} should be wider than ${near}`);
    // Whatever the span, half of it has to reach the far edge.
    const reach = (9.69 - 9.60) * 111320 * Math.cos((46.4 * Math.PI) / 180);
    assert.ok(far / 2 > reach || far === SPANS.at(-1));
});

test('land on the other side of the world does not widen it past the last span', () => {
    assert.equal(spanFor([{ bbox: [-100, -40, -99, -39] }], at), SPANS.at(-1));
});

test('an area with no geometry at all is ignored, not crashed on', () => {
    assert.equal(spanFor([{}, { ring: [] }], at), 500);
});

// The map had a grid and a triangle in the middle and nothing about where you
// are, which is the one thing a map is for. This is the hillshade it draws
// instead, from the same ground the player is standing on.

// Enough of a 2D context to see what was painted.
function fakeCanvas(size = 240) {
    const painted = [];
    return {
        width: size,
        height: size,
        painted,
        getContext: () => ({
            fillStyle: '', strokeStyle: '', lineWidth: 1,
            clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
            stroke() {}, closePath() {}, arc() {}, save() {}, restore() {},
            translate() {}, rotate() {},
            fillRect(x, y, w, h) { painted.push({ x, y, w, h, fill: this.fillStyle }); },
            strokeRect() {},
            fill() {},
        }),
    };
}

test('with ground to ask, the map is the land rather than a grid', () => {
    const canvas = fakeCanvas();
    const hill = { heightAt: (lon, lat) => 600 + (lat - 46.4) * 200000 };
    drawMinimap(canvas, { at, ground: hill });
    assert.ok(canvas.painted.length > 100, 'the map is shaded cell by cell');
    const fills = new Set(canvas.painted.map((p) => p.fill));
    assert.ok(fills.size > 3, 'a slope is more than one colour');
});

test('where there is no ground, the map says nothing rather than black', () => {
    const canvas = fakeCanvas();
    drawMinimap(canvas, { at, ground: { heightAt: () => null } });
    assert.equal(canvas.painted.length, 0, 'nothing is shaded');
});

test('and with no ground at all it is the grid it always was', () => {
    const canvas = fakeCanvas();
    assert.ok(drawMinimap(canvas, { at }) > 0);
    assert.equal(canvas.painted.length, 0);
});

// The fine ground reaches two and a half kilometres and the map reaches
// twenty, so asking only the level a player stands on drew a patch of land in
// the middle of the canvas with a grid around it. heightNear answers from the
// finest level that has the point, so the far corners are the coarse picture
// rather than nothing at all.
test('the map fills its canvas from whatever level has the ground', () => {
    const canvas = fakeCanvas();
    const near = 0.011;   // about 1.2 km at this latitude
    const ground = {
        // The fine level, and only around the middle of a 20 km map.
        heightAt: (lon, lat) => (Math.abs(lat - at.lat) < near
            && Math.abs(lon - at.lon) < near ? 700 : null),
        heightNear(lon, lat) {
            return this.heightAt(lon, lat) ?? 400 + (lat - 46.4) * 90000;
        },
    };
    const wide = [{ ring: [[at.lon - 0.08, at.lat - 0.05], [at.lon + 0.08, at.lat + 0.05]] }];

    const fine = fakeCanvas();
    drawMinimap(fine, { at, areas: wide, ground: { heightAt: ground.heightAt } });
    drawMinimap(canvas, { at, areas: wide, ground });

    assert.ok(canvas.painted.length > fine.painted.length * 4,
        `every level covers more than the fine one: ${canvas.painted.length}`
        + ` vs ${fine.painted.length}`);
    const corners = canvas.painted.filter((p) => p.x < 12 && p.y < 12);
    assert.ok(corners.length > 0, 'including the corner of the canvas');
});

// SPEC §3.7: a compile is minutes of somebody's GPU on a piece of ground, and
// the map is where that ground is. Drawn while this machine is working on it.
test('the tile this machine is working on is a box on the map, named', () => {
    const canvas = fakeCanvas();
    const words = [];
    const ctx = canvas.getContext();
    canvas.getContext = () => Object.assign(ctx, {
        measureText: () => ({ width: 60 }),
        fillText: (word) => words.push(word),
        strokeRect(x, y, w, h) { canvas.painted.push({ x, y, w, h, stroke: true }); },
    });
    drawMinimap(canvas, { at, working: {
        west: at.lon - 0.005, east: at.lon + 0.005,
        south: at.lat - 0.004, north: at.lat + 0.004, word: '14/8548/5801',
    } });
    assert.ok(canvas.painted.some((p) => p.stroke), 'the tile is outlined');
    assert.deepEqual(words, ['14/8548/5801'], 'and says which tile it is');
});

// Enough of a 2D context to record what a draw asked for, and to record every
// lon/lat the shading looked the ground up at.
const asked = [];

function fakeCtx(drawn) {
    return new Proxy({}, {
        get: (_, name) => {
            if (name === 'fillStyle' || name === 'strokeStyle' || name === 'lineWidth'
                || name === 'font') return '';
            return (...args) => drawn.push([name, ...args]);
        },
        set: () => true,
    });
}

// A square of ground is a square on the map, whatever shape the map is. It was
// not: the corner map is square and hid it, and the map under an open job is
// 380 by 220 and drew every z14 tile as a 380-by-220 rectangle.
test('a square of ground is drawn square on a map that is not', () => {
    const drawn = [];
    const ctx = fakeCtx(drawn);
    asked.length = 0;
    const ground = { heightAt: (lon, lat) => { asked.push([lon, lat]); return 600; } };
    // Two hundred metres across, on a canvas half as tall as it is wide.
    hillshade(ctx, { w: 400, h: 200, at, span: 200, cos: Math.cos((46.4 * Math.PI) / 180),
        ground });
    const cells = drawn.filter((d) => d[0] === 'fillRect');
    // The shading reaches the bottom of the canvas and no further: h/CELL rows.
    // It covers the canvas and one cell over, not two canvases' worth.
    const lowest = Math.max(...cells.map((d) => d[2]));
    assert.ok(lowest >= 194 && lowest <= 206, `the shading stops at ${lowest} of 200`);
    // And one cell of the shading is the same number of metres either way,
    // which is the whole of it: it was span/w across and span/h up.
    const step = (values, perDeg) => {
        const sorted = [...new Set(values)].sort((a, b) => a - b);
        return Math.abs(sorted[1] - sorted[0]) * perDeg;
    };
    const across = step(asked.map((p) => p[0]), 111320 * Math.cos((46.4 * Math.PI) / 180));
    const down = step(asked.map((p) => p[1]), 111320);
    assert.ok(Math.abs(across - down) < 0.01,
        `a cell is ${across.toFixed(2)} m across and ${down.toFixed(2)} m down`);
});

// ------------------------------------------------- where one tile is

// The same map, of one tile, on the card and in the opened card
// (client/js/poolcard.js, client/js/jobdetail.js). It is drawn on a canvas
// wider than it is tall, which is what the aspect went wrong on: the tile was
// measured w/span across and h/span down, so a square tile came out the shape
// of the canvas — a z14 tile drawn half again as wide as it is deep.
function wideCanvas(w, h) {
    const canvas = fakeCanvas(w);
    canvas.height = h;
    const ctx = canvas.getContext();
    canvas.getContext = () => Object.assign(ctx, {
        font: '', measureText: () => ({ width: 60 }), fillText() {},
        strokeRect(x, y, ww, hh) { canvas.boxes.push({ x, y, w: ww, h: hh }); },
    });
    canvas.boxes = [];
    return canvas;
}

test('a square tile is drawn square, whatever shape the canvas is', () => {
    for (const [w, h] of [[380, 220], [320, 180], [200, 200]]) {
        const canvas = wideCanvas(w, h);
        drawWhere(canvas, { z: 14, x: 8548, y: 5801 }, {});
        const [box] = canvas.boxes;
        assert.ok(box, 'the tile is outlined');
        assert.ok(Math.abs(box.w / Math.abs(box.h) - 1) < 0.02,
            `${w}x${h}: the tile came out ${box.w} by ${box.h}`);
    }
});

test('the tile is held on the map however far away you are standing', () => {
    const tile = { z: 14, x: 8548, y: 5801 };
    const c = tileCenter(tile.z, tile.x, tile.y);
    const span = (metres) => drawWhere(wideCanvas(320, 180), tile,
        { at: { lon: c.lon + metres / 85000, lat: c.lat } });
    const near = span(0);
    assert.ok(span(3000) > near, 'standing off it widens the map');
    // And not without bound: a player on another continent gets a map of the
    // tile, not a map of the continent with the tile invisible in it.
    assert.ok(span(4e6) < near * 6, 'a player far away still gets a map of the tile');
});

test('the map of a tile is the ground under it, not a grid', () => {
    const canvas = wideCanvas(320, 180);
    drawWhere(canvas, { z: 14, x: 8548, y: 5801 },
        { ground: { heightAt: (lon, lat) => 600 + (lat - 46.4) * 200000 } });
    const shaded = canvas.painted.filter((p) => p.w <= 8);
    assert.ok(shaded.length > 100, `the ground is shaded cell by cell: ${shaded.length}`);
});
