// The map in the corner: what span holds the land it has to draw.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drawMinimap, SPANS, spanFor } from '../js/hudmap.js';

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
