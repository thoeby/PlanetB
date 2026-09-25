// EDT.2 — contours by marching squares, on a synthetic cone: every contour of
// a cone is a circle, and its radius is how far below the top it is.
import test from 'node:test';
import assert from 'node:assert/strict';

import { boldAt, isolines } from '../lib/contour.js';

const N = 81;
// The top is off the 2 m ladder, so no level passes exactly through a vertex.
const TOP = 40.37;
const cone = (i, j) => TOP - Math.hypot(i - 40, j - 40);

test('the contours of a cone are circles at the right radius', () => {
    const segs = isolines(cone, 0, 0, N - 1, N - 1, 2);
    assert.ok(segs.length > 100);
    for (const [ai, aj, bi, bj, level] of segs) {
        for (const [i, j] of [[ai, aj], [bi, bj]]) {
            const r = Math.hypot(i - 40, j - 40);
            assert.ok(Math.abs(r - (TOP - level)) < 0.1, `r ${r} at level ${level}`);
        }
        assert.ok(level % 2 === 0);
    }
    const levels = new Set(segs.map((s) => s[4]));
    assert.ok(levels.has(2) && levels.has(40));
});

test('each contour is closed: every end meets another end', () => {
    const segs = isolines(cone, 0, 0, N - 1, N - 1, 10);
    const ends = new Map();
    const key = (i, j, l) => `${i.toFixed(6)},${j.toFixed(6)},${l}`;
    // The cone's foot runs off the grid below 0 m; above it every ring closes.
    for (const [ai, aj, bi, bj, l] of segs.filter((s) => s[4] > 0)) {
        for (const k of [key(ai, aj, l), key(bi, bj, l)]) ends.set(k, (ends.get(k) ?? 0) + 1);
    }
    for (const [k, n] of ends) assert.equal(n, 2, `open end at ${k}`);
});

test('flat ground has no contours; the grid is contours of position', () => {
    assert.equal(isolines(() => 3, 0, 0, 10, 10, 2).length, 0);
    const grid = isolines((i) => i * 1.5, 0, 0, 10, 10, 5);
    // x = 5, 10 and 15 metres → three lines, each ten cells long.
    assert.equal(grid.length, 30);
    assert.ok(grid.every((s) => Math.abs(s[0] - s[2]) < 1e-9));
});

test('every fifth 2 m contour is bold', () => {
    assert.equal(boldAt(10), true);
    assert.equal(boldAt(12), false);
    assert.equal(boldAt(-20), true);
});
