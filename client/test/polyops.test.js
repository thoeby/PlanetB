// EDT.20 — union, difference and intersection of areas, a painted blob, and
// clipping to a land: exact to the cell, and never refusing a shape.
import test from 'node:test';
import assert from 'node:assert/strict';

import { areaOf, difference, intersection, overlaps, paintedOf, pullInside, ringArea, union }
    from '../lib/polyops.js';

const square = (x, z, s) => [[[x, z], [x + s, z], [x + s, z + s], [x, z + s]]];
const near = (a, b, eps) => Math.abs(a - b) <= eps;

test('two overlapping squares make one area of their union', () => {
    const got = union([square(0, 0, 10)], [square(5, 5, 10)]);
    assert.equal(got.length, 1, 'one polygon');
    assert.equal(got[0].length, 1, 'no holes');
    assert.ok(near(areaOf(got), 175, 1.5), `area ${areaOf(got)}`);
    // Apart, they stay two.
    assert.equal(union([square(0, 0, 10)], [square(20, 0, 10)]).length, 2);
});

test('a different kind cuts a hole; clipping keeps what is inside', () => {
    const holed = difference([square(0, 0, 30)], [square(10, 10, 10)]);
    assert.equal(holed.length, 1);
    assert.equal(holed[0].length, 2, 'an outer ring and a hole');
    assert.ok(near(areaOf(holed), 800, 3), `area ${areaOf(holed)}`);
    const clipped = intersection([square(-10, -10, 30)], [square(0, 0, 100)]);
    assert.ok(near(areaOf(clipped), 400, 2));
    for (const [x, z] of clipped[0][0]) assert.ok(x >= -0.2 && z >= -0.2, `${x},${z} is in`);
    assert.deepEqual(intersection([square(0, 0, 5)], [square(50, 50, 5)]), []);
});

test('overlap is sharing ground, not touching boxes', () => {
    assert.equal(overlaps([square(0, 0, 10)], [square(5, 5, 10)]), true);
    assert.equal(overlaps([square(0, 0, 10)], [square(20, 20, 10)]), false);
});

test('a painted stroke is one area; its rings are simplified and closed', () => {
    const centres = [];
    for (let x = 0; x <= 40; x += 1) centres.push([x, Math.sin(x / 8) * 5]);
    const got = paintedOf(centres, 4);
    assert.equal(got.length, 1);
    assert.ok(got[0][0].length < 200, `${got[0][0].length} points`);
    // Close to a 48 × 8 sausage bent along a sine.
    assert.ok(areaOf(got) > 300 && areaOf(got) < 460, `area ${areaOf(got)}`);
    assert.ok(Math.abs(ringArea(got[0][0])) > 0);
});

test('clipped means inside: corners the raster left past the edge go onto it', () => {
    const land = [square(0, 0, 100)];
    const got = pullInside(intersection([square(-10, 20, 30)], land), land);
    for (const [x] of got[0][0]) assert.ok(x >= 0, `${x} is on the land`);
});
