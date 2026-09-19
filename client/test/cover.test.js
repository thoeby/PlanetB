// FND.12 — the ground's cover: the classes in a tile, and where one ends.

import test from 'node:test';
import assert from 'node:assert/strict';

import { distanceField, hexOf, readCover, thinningOf } from '../lib/gen/cover.js';

test('the distance field is the exact euclidean one', () => {
    // One lit pixel in the middle of a 5×5: every other pixel's distance to it
    // is the ruler's answer, not a chamfer approximation.
    const d = distanceField((i) => i === 12, 5, 5);
    assert.equal(d[12], 0);
    assert.equal(d[11], 1);
    assert.equal(d[7], 1);
    assert.ok(Math.abs(d[6] - Math.SQRT2) < 1e-9, 'the diagonal is √2, not 2');
    assert.ok(Math.abs(d[0] - Math.hypot(2, 2)) < 1e-9, 'and the corner is √8');
});

// A raster: the left half one class, the right half another.
function twoHalves(n, left, right) {
    const data = new Uint8Array(n * n * 4);
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const c = i < n / 2 ? left : right;
            const k = (j * n + i) * 4;
            data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; data[k + 3] = 255;
        }
    }
    return { size: n, data };
}

const FOREST = [34, 139, 34];
const ROCK = [136, 136, 136];

const sources = [{
    layer: 'tlm', class_map: {
        [hexOf(...FOREST)]: { kind: 'landuse', key: 'landuse', value: 'forest' },
        [hexOf(...ROCK)]: { kind: 'natural', key: 'natural', value: 'bare_rock' },
    },
}];

test('a class is itself in the middle and half of it at the border', () => {
    const cover = readCover(twoHalves(64, FOREST, ROCK), sources,
        { seed: 1, metres: 64, blendOf: () => 4 });
    assert.deepEqual(cover.classes.map((c) => c.value), ['forest', 'bare_rock']);

    const deep = cover.weightsAt(0.1, 0.5);
    assert.equal(deep.length, 1, 'well inside the forest there is only forest');
    assert.equal(deep[0][0], 0);

    // Over the border, the two share it, and the shares add up to one.
    const edge = cover.weightsAt(0.5, 0.5);
    assert.equal(edge.length, 2, 'at the border it is both');
    assert.ok(Math.abs(edge[0][1] + edge[1][1] - 1) < 1e-9);
});

test('an unmapped colour is listed, and is not the ground', () => {
    const cover = readCover(twoHalves(32, FOREST, [1, 2, 3]), sources,
        { seed: 1, metres: 32, blendOf: () => 2 });
    assert.deepEqual(cover.classes.map((c) => c.value), ['forest']);
    assert.deepEqual(cover.unmapped, ['#010203']);
    assert.deepEqual(cover.weightsAt(0.95, 0.5), [], 'and nothing is drawn for it');
});

test('the same tile reads the same way twice', () => {
    const one = readCover(twoHalves(32, FOREST, ROCK), sources,
        { seed: 7, metres: 32, blendOf: () => 3 });
    const two = readCover(twoHalves(32, FOREST, ROCK), sources,
        { seed: 7, metres: 32, blendOf: () => 3 });
    for (const u of [0.2, 0.48, 0.5, 0.52, 0.8]) {
        assert.deepEqual(one.weightsAt(u, 0.4), two.weightsAt(u, 0.4));
    }
});

test('no source over the tile is no cover at all', () => {
    assert.equal(readCover(null, sources, {}), null);
});

test('a class is scattered as thickly as it holds the ground', () => {
    // 64 m across, the forest on the left, a twelve-metre soft border.
    const cover = readCover(twoHalves(64, FOREST, ROCK), sources,
        { seed: 3, metres: 64, blendOf: () => 12 });
    const thin = thinningOf(cover, 0, { uOf: (x) => x / 64, vOf: (z) => z / 64 });
    const deep = thin(8, 32);
    const near = thin(30, 32);
    const over = thin(60, 32);
    assert.equal(deep, 1, 'well inside the wood every draw is kept');
    assert.ok(near < deep && near > 0, 'towards the edge fewer of them are');
    assert.equal(over, 0, 'and well past it none at all');
    // The border wanders: the edge noise is half the blend width, which is
    // what keeps a raster's staircase from showing as a line of trees.
    assert.ok(thin(44, 32) > 0, 'the edge is not a straight line');
});
