// EDT.5 — sampling the ground along a line: every metre, the corners kept,
// the slope in percent, and the stretches steeper than a limit.
import test from 'node:test';
import assert from 'node:assert/strict';

import { metresBetween, nearestSample, overGradient, sampleAlong, sampleAt, slopes }
    from '../lib/profile.js';

const LAT = 46.3;
const M_LON = 111320 * Math.cos(LAT * Math.PI / 180);
// A point `x` metres east and `y` metres north of the origin.
const at = (x, y = 0) => ({ lon: 7.88 + x / M_LON, lat: LAT + y / 110540 });
// Ground rising 10 % to the east.
const ramp = (lon) => (lon - 7.88) * M_LON * 0.1;

test('a line is sampled every metre, and ends where it ends', () => {
    const s = sampleAlong([at(0), at(100)], ramp, 1);
    assert.equal(s.length, 101);
    assert.ok(Math.abs(s.at(-1).at - 100) < 1e-6);
    assert.ok(Math.abs(s[50].h - 5) < 1e-6);
    assert.ok(Math.abs(metresBetween(at(0), at(30, 40)) - 50) < 0.01);
});

test('the corners are samples, and distance runs on across them', () => {
    const s = sampleAlong([at(0), at(10), at(10, 10)], ramp, 3);
    assert.ok(s.some((p) => Math.abs(p.at - 10) < 1e-6), 'the corner is sampled');
    assert.ok(Math.abs(s.at(-1).at - 20) < 1e-3);
});

test('slope is rise over run in percent, signed', () => {
    const up = slopes(sampleAlong([at(0), at(50)], ramp, 1));
    assert.ok(up.every((p) => Math.abs(p - 10) < 1e-6));
    const down = slopes(sampleAlong([at(50), at(0)], ramp, 1));
    assert.ok(down.every((p) => Math.abs(p + 10) < 1e-6));
});

test('the stretches over a gradient are found, and nothing under it', () => {
    // Flat, then a 20 % bank from 40 m to 60 m, then flat again.
    const bank = (lon) => {
        const x = (lon - 7.88) * M_LON;
        return x < 40 ? 0 : x < 60 ? (x - 40) * 0.2 : 4;
    };
    const s = sampleAlong([at(0), at(100)], bank, 1);
    const over = overGradient(s, 12);
    assert.equal(over.length, 1);
    assert.ok(over[0].from >= 34 && over[0].from <= 42, `from ${over[0].from}`);
    assert.ok(over[0].to >= 56 && over[0].to <= 62, `to ${over[0].to}`);
    assert.ok(Math.abs(over[0].steepest - 20) < 0.5);
    assert.deepEqual(overGradient(s, 25), []);
});

test('the sample nearest a point, and the sample at a distance', () => {
    const s = sampleAlong([at(0), at(100)], ramp, 1);
    const n = nearestSample(s, at(30, 4).lon, at(30, 4).lat);
    assert.ok(Math.abs(n.sample.at - 30) < 1e-6);
    assert.ok(Math.abs(n.d - 4) < 0.01);
    assert.ok(Math.abs(sampleAt(s, 72.4).at - 72) < 1e-6);
});
