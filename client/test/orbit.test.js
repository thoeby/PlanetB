// EDT.3 — Blueprint's camera arithmetic: where it stands for a target, the
// pitch it is held to, and a zoom that keeps the pointer's ground under it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { PITCH_MAX, PITCH_MIN, clampPitch, fitDistance, orbitBy, orthoHeight, pose,
    zoomToward } from '../lib/orbit.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('straight down stands over the target; 45° stands back along the heading', () => {
    const t = { x: 10, y: 5, z: -3 };
    const down = pose({ yaw: 0, pitch: 90, distance: 100 }, t);
    assert.ok(near(down.pos.x, 10) && near(down.pos.y, 105) && near(down.pos.z, -3));
    assert.deepEqual(down.euler, [-90, -0, 0]);
    // Facing north (−z), the camera is south of the target.
    const tilted = pose({ yaw: 0, pitch: 45, distance: 100 }, t);
    assert.ok(tilted.pos.z > t.z);
    assert.ok(near(tilted.pos.y - t.y, tilted.pos.z - t.z, 1e-9));
    // Facing east, it is west of it.
    const east = pose({ yaw: 90, pitch: 45, distance: 100 }, t);
    assert.ok(east.pos.x < t.x && near(east.pos.z, t.z, 1e-9));
});

test('pitch is held between 30° and straight down', () => {
    assert.equal(clampPitch(10), PITCH_MIN);
    assert.equal(clampPitch(120), PITCH_MAX);
    const s = orbitBy({ yaw: 350, pitch: 60, distance: 10 }, 100, -400);
    assert.ok(s.yaw >= 0 && s.yaw < 360);
    assert.equal(s.pitch, PITCH_MIN);
});

test('zooming in towards the pointer moves the target towards it', () => {
    const t = { x: 0, y: 0, z: 0 };
    const at = { x: 100, y: 0, z: 0 };
    const got = zoomToward({ distance: 200 }, t, at, 0.5);
    assert.equal(got.distance, 100);
    assert.ok(near(got.target.x, 50));
    // Out, and away from it.
    const out = zoomToward({ distance: 200 }, t, at, 2);
    assert.ok(out.target.x < 0);
    // With nothing under the pointer, the target stays.
    assert.deepEqual(zoomToward({ distance: 200 }, t, null, 0.5).target, t);
});

test('a land is framed whole; ortho shows what perspective did at the target', () => {
    const d = fitDistance(700, 45);
    assert.ok(orthoHeight(d, 45) * 2 > 700);
    assert.ok(fitDistance(1e9, 45) <= 12000);
});
