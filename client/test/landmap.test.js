// The admin's map: what it is looking at, and what a click on it means.
//
// The view and the hit-testing are arithmetic, so they are checked here rather
// than by clicking a canvas in a browser. What the map draws is
// client/test/demshade.test.js and the browser specs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MAP, ZOOM_STEP, areaAt, boxOf, fitView, panned, pointInArea, projection, sizeMap,
    zoomed }
    from '../js/landmap.js';

// Visp, roughly the four kilometres tools/make-seed-dem.sh cuts.
const GROUND = { west: 7.8545, south: 46.2759, east: 7.9085, north: 46.3119 };
const FIT = fitView(GROUND);

const square = (id, west, south, east, north, extra = {}) => ({
    id,
    bbox: { west, south, east, north },
    outline: { type: 'Polygon',
        coordinates: [[[west, south], [east, south], [east, north],
            [west, north], [west, south]]] },
    ...extra,
});

test('the map starts on the whole of the world’s ground', () => {
    assert.deepEqual(FIT, { west: GROUND.west, south: GROUND.south,
        east: GROUND.east, north: GROUND.north });
    // And with no ground at all it is the whole globe rather than nothing.
    assert.equal(fitView(null).west, -180);
});

test('a point maps to a pixel and back again', () => {
    const p = projection(FIT);
    const [x, y] = p.toPx(7.8815, 46.2939);
    assert.ok(x > MAP.pad && x < MAP.w - MAP.pad, `x ${x}`);
    assert.ok(y > MAP.pad && y < MAP.h - MAP.pad, `y ${y}`);
    const [lon, lat] = p.toLonLat(x, y);
    assert.ok(Math.abs(lon - 7.8815) < 1e-9, `lon ${lon}`);
    assert.ok(Math.abs(lat - 46.2939) < 1e-9, `lat ${lat}`);
});

test('zooming in narrows the view and keeps it inside the world', () => {
    const inOnce = zoomed(FIT, ZOOM_STEP, FIT);
    assert.ok(inOnce.east - inOnce.west < FIT.east - FIT.west, 'it is narrower');
    assert.ok(inOnce.west >= FIT.west && inOnce.east <= FIT.east, 'and inside');
    // Out again from there is the whole world, never wider than it.
    const back = zoomed(inOnce, 1 / ZOOM_STEP, FIT);
    assert.ok(back.east - back.west <= FIT.east - FIT.west + 1e-12,
        'never wider than the ground it is a map of');
});

test('zooming about a point keeps that point where it was', () => {
    const at = { lon: 7.86, lat: 46.28 };      // the south-west corner of it
    const p0 = projection(FIT).toPx(at.lon, at.lat);
    const next = zoomed(FIT, ZOOM_STEP, FIT, at);
    const p1 = projection(next).toPx(at.lon, at.lat);
    assert.ok(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 1,
        `the thing under the cursor stays there: ${p0} -> ${p1}`);
});

test('panning stops at the edge of the world', () => {
    const view = zoomed(FIT, 4, FIT);
    const far = panned(view, 10, 10, FIT);
    assert.ok(far.east <= FIT.east + 1e-12, 'not off the east');
    assert.ok(far.north <= FIT.north + 1e-12, 'nor off the north');
    assert.ok(Math.abs((far.east - far.west) - (view.east - view.west)) < 1e-12,
        'and it is the same width it was, not squashed against the edge');
});

test('a click lands on the land under it, and on nothing where there is none', () => {
    const areas = [square('big', 7.86, 46.28, 7.90, 46.31),
        square('small', 7.87, 46.29, 7.88, 46.30)];
    assert.equal(areaAt(areas, 7.875, 46.295)?.id, 'small',
        'the smaller one, where one is inside another');
    assert.equal(areaAt(areas, 7.895, 46.305)?.id, 'big');
    assert.equal(areaAt(areas, 7.855, 46.277), null, 'and nothing outside both');
});

test('a ring with a bite out of it is not clicked through', () => {
    // An L: the notch is inside the bounding box and outside the land.
    const area = { id: 'L', outline: { type: 'Polygon', coordinates: [[
        [0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 0]]] } };
    assert.equal(pointInArea(area, 0.5, 0.5), true, 'in the arm');
    assert.equal(pointInArea(area, 1.5, 1.5), false, 'and not in the notch');
});

// Survey's map is twice as wide as it is tall (SPEC §2.1), and the ground it
// draws is not: the box the view is drawn into keeps the view's own
// proportions rather than filling whatever shape the panel is.
test('the ground is not stretched to fill the panel', () => {
    sizeMap(1400, 500);
    const b = boxOf(FIT);
    const wide = (FIT.east - FIT.west)
        * Math.cos((((FIT.north + FIT.south) / 2) * Math.PI) / 180);
    const tall = FIT.north - FIT.south;
    assert.ok(Math.abs((b.w / b.h) - (wide / tall)) < 1e-6,
        `the box is ${(b.w / b.h).toFixed(3)} and the ground ${(wide / tall).toFixed(3)}`);
    assert.ok(b.x > MAP.pad, 'and it is centred in what is left');
    // A point still comes back as itself, whatever the box.
    const p = projection(FIT);
    const [lon, lat] = p.toLonLat(...p.toPx(7.8815, 46.2939));
    assert.ok(Math.abs(lon - 7.8815) < 1e-9 && Math.abs(lat - 46.2939) < 1e-9);
    sizeMap(420, 300);
});
