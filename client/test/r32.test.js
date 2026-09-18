// FND.9 — the shaped ground: the file a land's heights are written to, and
// what the compiler makes of it.
//
// The important test is the last one: an edit of +2 m over a square gives
// exactly +2 m inside it and nothing outside, and the same edit twice is the
// same bytes (Invariant 2).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { gridFor, readR32, sampleR32, writeR32 } from '../lib/r32.js';
import { Terrain, applyHeightEdits } from '../lib/terrain.js';

const BBOX = [7.8, 46.29, 7.804, 46.292];

test('an r32 file says what it is and comes back unchanged', () => {
    const grid = gridFor(BBOX, 0.2);
    assert.ok(grid.width > 10 && grid.height > 5, 'the land is covered at 20 cm');
    grid.data[grid.width + 3] = 2.5;
    const bytes = writeR32(grid);
    const back = readR32(bytes);
    assert.equal(back.version, 'r32-v1');
    assert.deepEqual(back.bbox, BBOX);
    assert.equal(back.width, grid.width);
    assert.equal(back.data[grid.width + 3], 2.5);
    assert.deepEqual(Array.from(writeR32(back)), Array.from(bytes),
        'written twice, the same bytes');
});

test('a very large land is shaped at a coarser cell rather than refused', () => {
    const grid = gridFor([7, 46, 8, 46.5], 0.2);
    assert.ok(grid.width <= 2048 && grid.height <= 2048);
    assert.ok(grid.cell > 0.2, 'and the file says which cell it was shaped at');
});

test('the grid says nothing outside itself', () => {
    const grid = gridFor(BBOX, 0.2);
    grid.data.fill(3);
    assert.equal(sampleR32(grid, 7.802, 46.291), 3);
    assert.equal(sampleR32(grid, 7.9, 46.291), 0);
    assert.equal(sampleR32(grid, 7.802, 46.5), 0);
});

// The ground the compiler builds on: a square raised two metres inside the
// land, and the DEM's own height everywhere else.
test('an edit of +2 m is exactly +2 m inside the land and 0 outside', () => {
    const size = 33;
    const terrain = new Terrain({ sw: { x: -100, z: 100 }, ne: { x: 100, z: -100 },
        size, dem: null });
    const grid = gridFor(BBOX, 0.2);
    grid.data.fill(2);
    // The land is the western half; local x maps onto longitude here.
    const half = (BBOX[0] + BBOX[2]) / 2;
    const toLonLat = (x) => ({
        lon: BBOX[0] + (x + 100) / 200 * (BBOX[2] - BBOX[0]),
        lat: (BBOX[1] + BBOX[3]) / 2,
    });
    applyHeightEdits(terrain, [{ grid, contains: (x) => toLonLat(x).lon <= half }],
        (x, z) => toLonLat(x, z));
    const at = (i, j) => terrain.h[j * size + i];
    assert.equal(at(2, 16), 2, 'inside the land, exactly two metres');
    assert.equal(at(30, 16), 0, 'outside it, nothing');
});

test('the same shaping twice is the same file', () => {
    const one = gridFor(BBOX, 0.2);
    const two = gridFor(BBOX, 0.2);
    for (const g of [one, two]) {
        for (let i = 0; i < 50; i++) g.data[i * 7 % g.data.length] = 1.25;
    }
    const sha = (b) => createHash('sha256').update(b).digest('hex');
    assert.equal(sha(writeR32(one)), sha(writeR32(two)));
});
