// The air: the fog density sky.js asks for is the one that takes half the
// contrast at VISIBILITY_M, and it has to do something at the distances a
// player actually looks over. 18 km (before db/0114's commit) left 99.9 % of
// the contrast at 500 m, which is no atmosphere at all.
import test from 'node:test';
import assert from 'node:assert/strict';

import { HORIZON, VISIBILITY_M, ZENITH } from '../js/sky.js';

const density = Math.sqrt(Math.LN2) / VISIBILITY_M;
// exp2 fog: transmittance is e^-(d\u00b7x)^2.
const seen = (m) => Math.exp(-((density * m) ** 2));

test('half the contrast is gone at the visibility distance', () => {
    assert.ok(Math.abs(seen(VISIBILITY_M) - 0.5) < 1e-6);
});

test('the air is visible over a valley and not over a street', () => {
    assert.ok(seen(60) > 0.999, 'nothing underfoot is hazed');
    assert.ok(seen(2000) < 0.95, 'a ridge two kilometres off is');
});

test('the horizon is the paler end of the sky', () => {
    for (let c = 0; c < 3; c++) assert.ok(HORIZON[c] > ZENITH[c]);
});
