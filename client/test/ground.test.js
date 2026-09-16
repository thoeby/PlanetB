// The ground drawn where nothing is published (client/js/ground.js): which
// tiles are drawn, and what the mesh of one is made of.
import test from 'node:test';
import assert from 'node:assert/strict';

import { covered, ringAround, tileGeometry } from '../js/ground.js';
import { key } from '../js/traverse.js';

const row = (z, x, y, published_version) => [key(z, x, y), { z, x, y, published_version }];

test('a published tile, or a published tile above it, covers the ground', () => {
    const tiles = new Map([row(14, 8550, 5809, 1), row(12, 2137, 1451, 0), row(10, 533, 363, 2)]);
    assert.ok(covered(tiles, 14, 8550, 5809), 'published at z14');
    assert.ok(!covered(tiles, 14, 8551, 5809), 'a neighbour that is not');
    assert.ok(covered(tiles, 14, 533 * 16 + 3, 363 * 16 + 5), 'under the published z10');
    assert.ok(!covered(tiles, 14, 8548, 5804), 'an unpublished z12 covers nothing');
});

test('the ring is the tiles around the camera, nearest first', () => {
    const ring = ringAround(10, 20, 1);
    assert.equal(ring.length, 9);
    assert.deepEqual(ring[0], { x: 10, y: 20 });
    assert.ok(ring.every((t) => Math.abs(t.x - 10) <= 1 && Math.abs(t.y - 20) <= 1));
});

test('a tile becomes a grid of heights in its own frame, lit and coloured', () => {
    const size = 8;
    const data = new Float32Array(size * size).fill(650);
    for (let i = 0; i < size; i++) data[3 * size + i] = 700;     // a ridge across
    const dem = { size, data, u0: 0, v0: 0, span: 1 };
    const g = tileGeometry(14, 8550, 5809, dem, 9);
    assert.equal(g.positions.length, 9 * 9 * 3);
    assert.equal(g.indices.length, 8 * 8 * 6);
    assert.equal(g.colors.length, 9 * 9 * 3);
    const ys = [];
    for (let k = 1; k < g.positions.length; k += 3) ys.push(g.positions[k]);
    assert.ok(Math.min(...ys) > 640 && Math.max(...ys) < 710, 'heights are metres above the sea');
    // The tile's centre is the frame's origin: the middle vertex is near x = z = 0.
    const mid = (9 * 9 - 1) / 2;
    assert.ok(Math.abs(g.positions[mid * 3]) < 20 && Math.abs(g.positions[mid * 3 + 2]) < 20);
    // Every normal is a unit vector, and the flat ground's points straight up.
    assert.ok(Math.abs(g.normals[1] - 1) < 1e-6);
    for (let k = 0; k < g.normals.length; k += 3) {
        const len = Math.hypot(g.normals[k], g.normals[k + 1], g.normals[k + 2]);
        assert.ok(Math.abs(len - 1) < 1e-5);
    }
    assert.ok(g.colors.every((c) => c >= 0 && c <= 1), 'colours are 0..1');
});
