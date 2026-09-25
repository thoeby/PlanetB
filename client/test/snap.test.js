// EDT.14 — where a node lands: each snap on its own, their order, and the
// boundary rule of PLAN-editors D5.
import test from 'node:test';
import assert from 'node:assert/strict';

import { PULL_M, endWords, snapPoint, stepped } from '../lib/snap.js';

// A 100 m square land, x east and z south.
const LAND = [[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]];
const near = (a, b, eps = 1e-9) => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;

test('nothing near: the point is where it was, with no tag', () => {
    const got = snapPoint([50, 50], { land: LAND, tol: 2 });
    assert.deepEqual(got, { p: [50, 50], hit: null });
});

test('a line end within reach wins, and says which kind of end', () => {
    const got = snapPoint([51, 50], { land: LAND, tol: 2,
        ends: [{ p: [52.5, 50], kind: 'highway' }], edges: [[[50, 0], [50, 100]]] });
    assert.ok(near(got.p, [52.5, 50]));
    assert.equal(got.hit, 'road end');
    assert.equal(endWords('waterway'), 'stream end');
    assert.equal(endWords('something'), 'line end');
});

test('the boundary, from inside and from just outside', () => {
    const inside = snapPoint([98.8, 40], { land: LAND, tol: 2 });
    assert.ok(near(inside.p, [100, 40]));
    assert.equal(inside.hit, 'boundary');
    const outside = snapPoint([110, 40], { land: LAND, tol: 2 });
    assert.ok(near(outside.p, [100, 40]), 'pulled back onto the boundary');
    assert.equal(outside.hit, 'boundary');
});

test('far into somebody else’s ground is refused', () => {
    const got = snapPoint([100 + PULL_M + 5, 40], { land: LAND, tol: 2 });
    assert.equal(got.refused, true);
});

test('an area edge, then 15° with Ctrl, then the grid', () => {
    const edge = snapPoint([51, 50], { land: LAND, tol: 2, edges: [[[50, 0], [50, 100]]] });
    assert.ok(near(edge.p, [50, 50]));
    assert.equal(edge.hit, 'area edge');
    const angled = snapPoint([60, 43], { land: LAND, tol: 2, angle: true, prev: [40, 40] });
    assert.equal(angled.hit, '15°');
    const a = Math.atan2(angled.p[1] - 40, angled.p[0] - 40) * 180 / Math.PI;
    assert.ok(Math.abs(a / 15 - Math.round(a / 15)) < 1e-9, `${a}° is a 15° step`);
    const gridded = snapPoint([60.4, 42.7], { land: LAND, tol: 2, grid: 1 });
    assert.deepEqual(gridded, { p: [60, 43], hit: 'grid' });
    const s = stepped([0, 0], [10, 1]);
    assert.ok(near(s, [Math.hypot(10, 1), 0], 1e-9));
});
