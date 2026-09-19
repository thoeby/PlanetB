// FND.13 — a class raster into shapes: the outline of what is there, taken
// off the staircase, and the same answer every time.

import test from 'node:test';
import assert from 'node:assert/strict';

import { outlines, ringArea, shapesOf, simplify } from '../lib/gen/trace.js';

// A 4 × 4 block in the middle of a 10 × 10 grid.
const block = (i, j) => i >= 3 && i < 7 && j >= 3 && j < 7;

test('a square block comes out as one ring around it', () => {
    const rings = outlines(block, 10, 10);
    assert.equal(rings.length, 1, 'one shape');
    const box = rings[0].reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y),
        Math.max(b[2], x), Math.max(b[3], y)], [99, 99, -99, -99]);
    assert.deepEqual(box, [2.5, 2.5, 6.5, 6.5], 'and it is around the block');
    assert.ok(Math.abs(Math.abs(ringArea(rings[0])) - 16) < 1.01,
        'about the area of the sixteen cells');
});

test('nothing in the grid is no rings at all', () => {
    assert.deepEqual(outlines(() => false, 8, 8), []);
});

test('two blocks are two rings', () => {
    const two = (i, j) => (i < 3 && j < 3) || (i > 6 && j > 6);
    assert.equal(outlines(two, 10, 10).length, 2);
});

test('the staircase comes off a straight edge', () => {
    const steps = [[0, 0], [1, 0], [2, 0], [3, 0.0001], [4, 0], [5, 0]];
    assert.deepEqual(simplify(steps, 0.01), [[0, 0], [5, 0]],
        'a line that wanders by a tenth of a millimetre is a line');
    assert.equal(simplify(steps, 0).length, 6, 'and no tolerance keeps every point');
});

test('a corner is never simplified away', () => {
    const corner = [[0, 0], [5, 0], [5, 5]];
    assert.deepEqual(simplify(corner, 0.5), corner);
});

test('the same raster traces the same shapes, in the same order', () => {
    const how = { toWorld: (x, y) => [x * 2, y * 2], tolerance: 0.4, smallest: 1 };
    const one = shapesOf(block, 10, 10, how);
    const two = shapesOf(block, 10, 10, how);
    assert.deepEqual(one, two);
    assert.equal(one.length, 1);
});

test('a speck of one cell is dropped, a real patch is not', () => {
    const speck = (i, j) => i === 1 && j === 1;
    assert.deepEqual(shapesOf(speck, 10, 10, { smallest: 4 }), []);
    assert.equal(shapesOf(block, 10, 10, { smallest: 4 }).length, 1);
});
