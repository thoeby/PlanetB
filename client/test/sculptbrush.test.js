// EDT.7 — the brush: strength in metres a second, a falloff curve from the
// core to the edge, round or square, Shift the other way, and the fade inside
// the boundary so a neighbour never gets a cliff.
import test from 'node:test';
import assert from 'node:assert/strict';

import { BAND_M, CURVES, bandAt, dab, falloffAt } from '../js/sculptbrush.js';
import { Shaping } from '../js/sculpt.js';
import { gridFor } from '../lib/r32.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// A 100 × 100 m land at 1 m cells, the whole of its box.
const LAT = 46.3;
const M_LON = 111320 * Math.cos(LAT * Math.PI / 180);
const BOX = [7.88, LAT, 7.88 + 100 / M_LON, LAT + 100 / 110540];
const ring = [[BOX[0], BOX[1]], [BOX[2], BOX[1]], [BOX[2], BOX[3]], [BOX[0], BOX[3]],
    [BOX[0], BOX[1]]];
const land = () => new Shaping({ id: 'a', bbox: { west: BOX[0], south: BOX[1], east: BOX[2],
    north: BOX[3] }, outline: { type: 'Polygon', coordinates: [ring] } }, gridFor(BOX, 1));
const mid = { lon: (BOX[0] + BOX[2]) / 2, lat: (BOX[1] + BOX[3]) / 2 };

test('every curve is full at the core, nothing at the edge, and falls between', () => {
    for (const curve of CURVES) {
        assert.equal(falloffAt(0, { curve }), 1);
        assert.equal(falloffAt(0.3, { soft: 0.6, curve }), 1, `${curve} core`);
        assert.equal(falloffAt(1, { curve }), 0);
        let was = 1;
        for (let t = 0.4; t < 1; t += 0.05) {
            const k = falloffAt(t, { soft: 0.6, curve });
            assert.ok(k <= was + 1e-12 && k >= 0, `${curve} at ${t}`);
            was = k;
        }
    }
    // Sharp falls away faster than linear, and plateau holds on longer.
    assert.ok(falloffAt(0.7, { curve: 'sharp' }) < falloffAt(0.7, { curve: 'linear' }));
    assert.ok(falloffAt(0.7, { curve: 'plateau' }) > falloffAt(0.7, { curve: 'linear' }));
    // No softness is a hard edge.
    assert.equal(falloffAt(0.99, { soft: 0 }), 1);
});

test('a dab is strength × dt × falloff at the centre, so holding keeps raising', () => {
    const s = land();
    s.begin();
    dab(s, mid.lon, mid.lat, { brush: 'raise', size: 10, strength: 2, dt: 0.25 });
    assert.ok(near(s.at(mid.lon, mid.lat), 0.5, 0.02), `${s.at(mid.lon, mid.lat)}`);
    for (let f = 0; f < 60; f++) {
        dab(s, mid.lon, mid.lat, { brush: 'raise', size: 10, strength: 2, dt: 1 / 60 });
    }
    assert.ok(near(s.at(mid.lon, mid.lat), 2.5, 0.05), 'a second longer is 2 m higher');
    // The same second in thirty frames or in six is the same ground.
    const a = land();
    const b = land();
    const raise = (dt) => ({ brush: 'raise', size: 10, strength: 1, dt });
    for (let f = 0; f < 30; f++) dab(a, mid.lon, mid.lat, raise(1 / 30));
    for (let f = 0; f < 6; f++) dab(b, mid.lon, mid.lat, raise(1 / 6));
    assert.ok(near(a.at(mid.lon, mid.lat), b.at(mid.lon, mid.lat), 1e-4));
});

test('Shift lowers; square reaches the corners a circle does not', () => {
    const s = land();
    dab(s, mid.lon, mid.lat, { brush: 'raise', size: 10, strength: 1, dt: 1, invert: true });
    assert.ok(s.at(mid.lon, mid.lat) < -0.9);
    const round = land();
    const square = land();
    const corner = { lon: mid.lon + 4 / M_LON, lat: mid.lat + 4 / 110540 };
    const how = { brush: 'raise', size: 10, strength: 1, dt: 1, soft: 0 };
    dab(round, mid.lon, mid.lat, how);
    dab(square, mid.lon, mid.lat, { ...how, shape: 'square' });
    assert.ok(square.at(corner.lon, corner.lat) > 0.9, 'the square fills the corner');
    assert.ok(round.at(corner.lon, corner.lat) < square.at(corner.lon, corner.lat) - 0.5,
        'the circle does not');
});

test('the brush fades over the last metres inside the boundary', () => {
    assert.equal(bandAt([ring], mid.lon, mid.lat), 1);
    const edge = { lon: BOX[0] + 1 / M_LON, lat: mid.lat };
    assert.ok(near(bandAt([ring], edge.lon, edge.lat), 1 / BAND_M, 0.02));
    const s = land();
    const t = land();
    const how = { brush: 'raise', size: 6, strength: 1, dt: 1, soft: 0 };
    dab(s, edge.lon + 1 / M_LON, edge.lat, how);
    dab(t, edge.lon + 1 / M_LON, edge.lat, { ...how, blend: false });
    assert.ok(s.at(edge.lon, edge.lat) < 0.35, 'faded near the edge');
    assert.ok(t.at(edge.lon, edge.lat) > 0.95, 'and not when the operator turns it off');
});

test('a bed is laid in one pass, no steeper than asked, and one undo takes it', async () => {
    const { alongLine } = await import('../js/sculptbrush.js');
    const s = land();
    // Ground rising 20 % to the east; a bed across it at no more than 8 %.
    const ground = (lon) => (lon - BOX[0]) * M_LON * 0.2;
    const a = { lon: BOX[0] + 10 / M_LON, lat: mid.lat };
    const b = { lon: BOX[0] + 90 / M_LON, lat: mid.lat };
    const got = alongLine(s, [a, b], { width: 6, shoulder: 1, gradient: 8, ground });
    assert.ok(got.moved > 0);
    assert.ok(got.steepest <= 8.001, `steepest ${got.steepest}`);
    assert.equal(s.strokes.length, 1);
    s.undo();
    assert.ok(near(s.at(mid.lon, mid.lat), 0));
});

test('a plane with a fall drops towards its bearing, and is level with none', async () => {
    const { bearing, fallPlane } = await import('../js/sculptbrush.js');
    const at = { lon: mid.lon, lat: mid.lat, h: 100 };
    const east = { lon: mid.lon + 10 / M_LON, lat: mid.lat };
    const north = { lon: mid.lon, lat: mid.lat + 10 / 110540 };
    const p = fallPlane(at, 5, 90);
    assert.ok(near(p(at.lon, at.lat), 100));
    assert.ok(near(p(east.lon, east.lat), 99.5, 1e-3), 'half a metre lower 10 m east');
    assert.ok(near(p(north.lon, north.lat), 100, 1e-6), 'level across the fall');
    assert.ok(near(fallPlane(at, 0, 90)(east.lon, east.lat), 100));
    assert.ok(near(bearing(at, east), 90, 1e-3));
    assert.ok(near(bearing(at, north), 0, 1e-6));
});

test('Flatten with a fall shapes a terrace that drains; Level holds a height', async () => {
    const { fallPlane } = await import('../js/sculptbrush.js');
    const s = land();
    const ground = () => 50;
    const plane = fallPlane({ lon: mid.lon, lat: mid.lat, h: 52 }, 4, 90);
    for (let f = 0; f < 20; f++) {
        dab(s, mid.lon, mid.lat, { brush: 'flatten', size: 20, strength: 5, dt: 0.5,
            soft: 0.2, plane, ground });
    }
    const w = s.at(mid.lon - 5 / M_LON, mid.lat) + 50;
    const e = s.at(mid.lon + 5 / M_LON, mid.lat) + 50;
    assert.ok(near(w - e, 0.4, 0.05), `west ${w} east ${e}`);
    const t = land();
    for (let f = 0; f < 20; f++) {
        dab(t, mid.lon, mid.lat, { brush: 'level', size: 20, strength: 5, dt: 0.5,
            soft: 0.2, target: 47, ground });
    }
    assert.ok(near(t.at(mid.lon, mid.lat) + 50, 47, 1e-3));
});
