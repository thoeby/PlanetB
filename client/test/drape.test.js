// A boundary drawn in QGIS is four corners. Over a mountainside four corners
// are a line through the inside of the mountain — the corners sit on the
// ground and everything between them is a straight line in the air. This is
// the half of client/js/land.js that puts the line back on the hill.

import assert from 'node:assert/strict';
import test from 'node:test';

import { drape, drawAreas } from '../js/land.js';

// A flat earth in metres: one degree is 111 320 m either way, and the ground
// under a point is a ridge running north-south.
const origin = {
    localOf: ({ lon, lat, h }) => ({ x: lon * 111320, y: h, z: -lat * 111320 }),
};
const ridge = { heightAt: (p) => 200 - Math.abs(p.x) / 10 };

const SQUARE = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]];

// Enough of PlayCanvas for drawAreas to draw into nothing.
const PC = {
    Color: class {},
    Vec3: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } },
};

test('a corner-to-corner edge is cut into steps the hill can be asked about', () => {
    const points = drape(SQUARE, origin, ridge);
    assert.ok(points.length > SQUARE.length * 10,
        `a kilometre of boundary is more than ${SQUARE.length} points`);
});

test('every point of it is on the ground under it', () => {
    for (const p of drape(SQUARE, origin, ridge)) {
        assert.ok(Math.abs(p.y - (ridge.heightAt(p) + 1.5)) < 1e-6,
            `${p.y} is not the ground at ${p.x}`);
    }
});

test('it follows the hill rather than cutting through it', () => {
    const points = drape(SQUARE, origin, ridge);
    const heights = points.map((p) => p.y);
    assert.ok(Math.max(...heights) - Math.min(...heights) > 50,
        'the line rises and falls with the ridge it crosses');
});

test('the corners are still the corners', () => {
    const points = drape(SQUARE, origin, ridge);
    for (const [lon, lat] of SQUARE) {
        const want = origin.localOf({ lon, lat, h: 0 });
        assert.ok(points.some((p) => Math.abs(p.x - want.x) < 1e-6
            && Math.abs(p.z - want.z) < 1e-6), `${lon},${lat} is missing`);
    }
});

test('with no ground to ask, the line is still drawn', () => {
    const points = drape(SQUARE, origin, { heightAt: () => null });
    assert.ok(points.length > 4);
    assert.ok(points.every((p) => Number.isFinite(p.y)));
});

test('a ring of two points is one edge, not a crash', () => {
    assert.equal(drape([[0, 0]], origin, ridge).length, 1);
    assert.equal(drape([], origin, ridge).length, 0);
});

// Draping is a few hundred questions to the terrain per boundary, and the
// world draws every boundary every frame. Asking them every frame is a page
// that runs at one frame a second.
test('the drape is not recomputed for every frame', () => {
    let asked = 0;
    const counting = { heightAt: (p) => { asked += 1; return ridge.heightAt(p); } };
    const area = { id: 'a', mine: true, outline: { type: 'Polygon', coordinates: [SQUARE] } };
    const ctx = { pc: PC, app: { drawLine() {} }, terrain: counting,
        origin: { ...origin, anchor: { lon: 0, lat: 0, h: 0 } } };

    drawAreas(ctx, [area]);
    const first = asked;
    assert.ok(first > 50, 'the first frame does the work');
    for (let i = 0; i < 20; i++) drawAreas(ctx, [area]);
    assert.equal(asked, first, 'and the next twenty frames do none of it');
});

test('the anchor moving is the ground moving, so the drape is done again', () => {
    let asked = 0;
    const counting = { heightAt: (p) => { asked += 1; return ridge.heightAt(p); } };
    const area = { id: 'b', mine: true, outline: { type: 'Polygon', coordinates: [SQUARE] } };
    const ctx = { pc: PC, app: { drawLine() {} }, terrain: counting,
        origin: { ...origin, anchor: { lon: 0, lat: 0, h: 0 } } };
    drawAreas(ctx, [area]);
    const first = asked;
    ctx.origin = { ...origin, anchor: { lon: 1, lat: 1, h: 0 } };
    drawAreas(ctx, [area]);
    assert.ok(asked > first, 'a rebase puts every vertex in a new frame');
});
