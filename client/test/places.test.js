// Whether an answer that has just arrived is still about where the player is.
//
// The line under the player is written by an answer that comes back from the
// world, and the question is re-asked as they move. Deciding whether an answer
// is still wanted was exact equality on the two floats — and a camera drifts
// by fractions of a metre every frame, so under any load at all every answer
// was thrown away by the next question and the line never changed from
// "nowhere yet".

import test from 'node:test';
import assert from 'node:assert/strict';

import { SAME_SPOT_DEG, sameSpot } from '../js/places.js';

const AT = { lon: 7.8815, lat: 46.2939 };

test('a camera that drifted a millimetre is still standing there', () => {
    const drifted = { lon: AT.lon + 1e-9, lat: AT.lat - 2e-9 };
    assert.notEqual(drifted.lon, AT.lon, 'the floats really are different');
    assert.equal(sameSpot(AT, drifted), true);
});

test('and one that walked a hundred metres is not', () => {
    assert.equal(sameSpot(AT, { lon: AT.lon, lat: AT.lat + 0.001 }), false);
});

test('the edge of it is the distance the question is re-asked at', () => {
    assert.equal(sameSpot(AT, { lon: AT.lon, lat: AT.lat + SAME_SPOT_DEG * 0.99 }),
        true, 'just inside is still here');
    assert.equal(sameSpot(AT, { lon: AT.lon, lat: AT.lat + SAME_SPOT_DEG * 1.01 }),
        false, 'and just outside is somewhere else');
});

test('nothing is not somewhere', () => {
    assert.equal(sameSpot(null, AT), false);
    assert.equal(sameSpot(AT, undefined), false);
});
