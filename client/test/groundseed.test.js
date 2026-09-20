// db/0174 — the ground is seeded on its own, so it is not outbid by whatever
// stands on it. The seed is allocated across every triangle in the tile at
// once (client/lib/sampling.js allocate): by area, and then a fifth of it by
// area x detail, which a hillside of one colour always loses. On a tile with
// buildings and trees on it the ground came out with a sixth of the seed.
import test from 'node:test';
import assert from 'node:assert/strict';

import { rng } from '../lib/poly.js';
import { sampleSurfaces, seedSurfaces } from '../lib/sampling.js';

const SIDE = 100;

// One flat quad of ground, one colour all over: nothing to see on it at all.
const ground = () => ({
    material: 'terrain',
    positions: new Float32Array([0, 0, 0, SIDE, 0, 0, SIDE, 0, SIDE, 0, 0, SIDE]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    colors: new Float32Array(12).fill(0.5),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
});

// And what stands on it: six hundred roof-and-wall triangles, three times the
// ground's own area between them, every vertex a different colour and a
// different normal — which is what `detailOf` spends the budget on.
function clutter() {
    const positions = [];
    const normals = [];
    const colors = [];
    const indices = [];
    for (let k = 0; k < 600; k++) {
        const at = positions.length / 3;
        const x = (k % 25) * 4;
        const z = Math.floor(k / 25) * 4;
        positions.push(x, 1, z, x + 10, 11, z, x, 1, z + 10);
        normals.push(0, 1, 0, 1, 0, 0, 0, 0, 1);
        colors.push(0, 0, 0, 1, 1, 1, 1, 0, 0);
        indices.push(at, at + 1, at + 2);
    }
    return { material: 'roof',
        positions: new Float32Array(positions), normals: new Float32Array(normals),
        colors: new Float32Array(colors), indices: new Uint32Array(indices) };
}

// The ground is the only surface at y = 0; the clutter starts a metre up.
const onGround = (f) => {
    let n = 0;
    for (let i = 0; i < f.count; i++) if (f.y[i] === 0) n++;
    return n;
};

const spacing = (n) => Math.sqrt((SIDE * SIDE) / n);

test('the ground gets the share it is promised, not the share it can win', () => {
    const meshes = [ground(), clutter()];
    const how = { spread: 0.5, even: true };
    const was = sampleSurfaces(meshes, 20_000, rng(7), how);
    const now = seedSurfaces(meshes, 20_000, rng(7), { ...how, floor: 0.66 });
    assert.equal(now.count, 20_000, 'the whole seed is still spent');
    assert.ok(onGround(was) / 20_000 < 0.2,
        `the old allocation left the ground a sixth: ${onGround(was)}`);
    assert.ok(onGround(now) / 20_000 >= 0.65,
        `and it is two thirds now: ${onGround(now)}`);
});

test('which is the difference between a hole and no hole', () => {
    const meshes = [ground(), clutter()];
    const how = { spread: 0.5, even: true };
    const was = spacing(onGround(sampleSurfaces(meshes, 20_000, rng(7), how)));
    const now = spacing(onGround(seedSurfaces(meshes, 20_000, rng(7),
        { ...how, floor: 0.66 })));
    assert.ok(now < was / 1.9,
        `the ground's splats are half as far apart: ${was.toFixed(2)} m to ${now.toFixed(2)} m`);
});

test('a tile that is all ground, or none of it, is seeded exactly as it was', () => {
    const how = { spread: 0.5, even: true };
    for (const only of [[ground()], [clutter()]]) {
        assert.deepEqual(seedSurfaces(only, 500, rng(3), { ...how, floor: 0.66 }).x,
            sampleSurfaces(only, 500, rng(3), how).x);
    }
});

test('and a floor of nothing leaves the ground its own area share', () => {
    const meshes = [ground(), clutter()];
    const how = { spread: 0.5, even: true };
    const now = seedSurfaces(meshes, 20_000, rng(7), { ...how, floor: 0 });
    // A fifth of the surface in this tile is ground, and it is given a fifth:
    // the detail weighting no longer takes from it even when nothing is
    // promised. `floor` only ever adds.
    const share = (SIDE * SIDE) / (SIDE * SIDE + 600 * 50 * Math.sqrt(2));
    assert.ok(Math.abs(onGround(now) / 20_000 - share) < 0.01,
        `its area share (${share.toFixed(3)}), not a sixth of it: ${onGround(now)}`);
});
