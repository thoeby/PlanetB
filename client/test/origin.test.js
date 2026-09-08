// origin.test.js — the floating origin keeps local coordinates small and, more
// importantly, keeps them right: rebasing recomputes from geodetic originals
// rather than translating, so nothing drifts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FloatingOrigin } from '../js/origin.js';
import * as tm from '../lib/tilemath.js';

const AARAU = { lon: 8.09, lat: 47.0, h: 400 };

test('a point at the anchor is the local origin', () => {
    const o = new FloatingOrigin(AARAU);
    const p = o.localOf(AARAU);
    assert.ok(Math.hypot(p.x, p.y, p.z) < 1e-6, `${JSON.stringify(p)}`);
});

test('local and geodetic round-trip', () => {
    const o = new FloatingOrigin(AARAU);
    const g = o.geodeticOf({ x: 1234, y: 56, z: -7890 });
    const p = o.localOf(g);
    assert.ok(Math.abs(p.x - 1234) < 1e-6, `x ${p.x}`);
    assert.ok(Math.abs(p.y - 56) < 1e-6, `y ${p.y}`);
    assert.ok(Math.abs(p.z + 7890) < 1e-6, `z ${p.z}`);
});

test('no rebase inside 5 km, one beyond it', () => {
    const o = new FloatingOrigin(AARAU);
    assert.equal(o.rebase({ x: 3000, y: 2000, z: -3000 }), null);
    assert.equal(o.rebases, 0);
    const moved = o.rebase({ x: 6000, y: 100, z: 0 });
    assert.ok(moved && Math.hypot(moved.x, moved.y, moved.z) < 1e-6,
        'the camera is at the new anchor');
    assert.equal(o.rebases, 1);
});

test('height alone never triggers a rebase', () => {
    const o = new FloatingOrigin(AARAU);
    assert.equal(o.rebase({ x: 0, y: 300000, z: 0 }), null);
});

test('a rebase does not move anything on the globe', () => {
    const o = new FloatingOrigin(AARAU);
    const target = { lon: 8.2, lat: 47.1, h: 500 };
    const before = o.geodeticOf(o.localOf(target));
    o.rebase({ x: 20000, y: 0, z: -20000 });
    const after = o.geodeticOf(o.localOf(target));
    assert.ok(Math.abs(after.lon - before.lon) < 1e-9, `lon ${after.lon} vs ${before.lon}`);
    assert.ok(Math.abs(after.lat - before.lat) < 1e-9, `lat ${after.lat} vs ${before.lat}`);
    assert.ok(Math.abs(after.h - before.h) < 1e-3, `h ${after.h} vs ${before.h}`);
});

test('walking 200 km keeps every local coordinate small', () => {
    const o = new FloatingOrigin(AARAU);
    let g = { ...AARAU };
    let worst = 0;
    for (let i = 0; i < 200; i++) {
        g = o.geodeticOf({ ...o.localOf(g), x: o.localOf(g).x + 1000 });
        const local = o.localOf(g);
        worst = Math.max(worst, Math.hypot(local.x, local.z));
        o.rebase(local);
    }
    // Drift is measured before the rebase, so the bound is the trigger plus one
    // step of the walk.
    assert.ok(worst <= 5000 + 1000 + 1e-3, `worst drift ${worst}`);
    assert.ok(o.rebases > 30, `rebased ${o.rebases} times`);
    // Stepping east in the tangent plane follows a great circle, not a
    // parallel, so the latitude wanders a little; the journey is still east.
    const back = o.geodeticOf(o.localOf(g));
    assert.ok(Math.abs(back.lat - AARAU.lat) < 1, `latitude ${back.lat}`);
    assert.ok(back.lon - AARAU.lon > 2, `travelled ${back.lon - AARAU.lon} degrees east`);
});

test('the tile frame and the origin agree', () => {
    const o = new FloatingOrigin(tm.tileFrame(10, 535, 361, 0));
    const p = o.localOf(tm.tileFrame(10, 536, 361, 0));
    assert.ok(p.x > 0, 'the eastern neighbour is east');
    assert.ok(Math.abs(p.z) < 100, `and level with it: ${p.z}`);
});
