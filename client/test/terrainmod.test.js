// FND.11 — the shapes that used to move the ground, and the grid that moves it
// now, are the same ground.
//
// A `terrainmod` polygon said flatten, raise or lower and the compiler did it
// on every build. A land carries relative metres since FND.9. Converting one
// into the other must not change what anybody sees, and this is where that is
// proven — to the centimetre, over the same terrain, rather than by looking at
// two pictures of it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Terrain, applyHeightEdits, applyTerrainmods } from '../lib/terrain.js';
import { gridFor, sampleR32 } from '../lib/r32.js';
import { contains } from '../lib/poly.js';

const BBOX = [7.8, 46.29, 7.81, 46.30];
// The square the shape is about, in the middle of the land.
const RING = [[7.803, 46.293], [7.807, 46.293], [7.807, 46.297], [7.803, 46.297]];

// A tile 200 m across with a slope on it, and lon/lat laid over it so that a
// shape drawn in degrees and a grid written in degrees measure the same ground.
function world() {
    const size = 65;
    const terrain = new Terrain({ sw: { x: -100, z: 100 }, ne: { x: 100, z: -100 },
        size, dem: null });
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) terrain.h[j * size + i] = 400 + i * 0.4 + j * 0.1;
    }
    const toLonLat = (x, z) => ({
        lon: BBOX[0] + (x + 100) / 200 * (BBOX[2] - BBOX[0]),
        lat: BBOX[3] - (z + 100) / 200 * (BBOX[3] - BBOX[1]),
    });
    return { terrain, size, toLonLat };
}

const local = (terrain, toLonLat) => {
    const rings = [RING.map(([lon, lat]) => {
        // The shape, in the tile's own metres, which is what the old compiler
        // was handed.
        const u = (lon - BBOX[0]) / (BBOX[2] - BBOX[0]);
        const v = (BBOX[3] - lat) / (BBOX[3] - BBOX[1]);
        return [u * 200 - 100, v * 200 - 100];
    })];
    return { id: '1', kind: 'terrainmod', props: { op: 'flatten', amount: 0 },
        rings, contains: (x, z) => contains(rings, x, z), toLonLat };
};

// What client/js/oldshapes.js writes, written here the same way: the level the
// shape flattens to, less whatever the ground says at each cell.
function convert(grid, ground) {
    const level = RING.reduce((s, [lon, lat]) => s + ground(lon, lat), 0) / RING.length;
    for (let j = 0; j < grid.height; j++) {
        for (let i = 0; i < grid.width; i++) {
            const lon = BBOX[0] + (BBOX[2] - BBOX[0]) * i / (grid.width - 1);
            const lat = BBOX[3] - (BBOX[3] - BBOX[1]) * j / (grid.height - 1);
            if (!contains([RING], lon, lat)) continue;
            grid.data[j * grid.width + i] = level - ground(lon, lat);
        }
    }
    return grid;
}

test('a flattening shape and the grid it becomes are the same ground', () => {
    const a = world();
    const b = world();
    const ground = (lon, lat) => {
        const u = (lon - BBOX[0]) / (BBOX[2] - BBOX[0]);
        const v = (BBOX[3] - lat) / (BBOX[3] - BBOX[1]);
        const i = Math.round(u * (a.size - 1));
        const j = Math.round(v * (a.size - 1));
        return 400 + i * 0.4 + j * 0.1;
    };

    applyTerrainmods(a.terrain, [local(a.terrain, a.toLonLat)], []);

    const grid = convert(gridFor(BBOX, 2), ground);
    applyHeightEdits(b.terrain, [{ grid, contains: () => true }],
        (x, z) => b.toLonLat(x, z));

    let worst = 0;
    for (let k = 0; k < a.terrain.h.length; k++) {
        worst = Math.max(worst, Math.abs(a.terrain.h[k] - b.terrain.h[k]));
    }
    assert.ok(worst < 0.06, `the two grounds differ by ${worst.toFixed(3)} m`);
});

test('the grid says nothing where the shape said nothing', () => {
    // A sloping ground, so flattening it is something rather than nothing.
    const grid = convert(gridFor(BBOX, 2), (lon) => 400 + (lon - BBOX[0]) * 10000);
    assert.equal(sampleR32(grid, 7.8005, 46.2905), 0, 'outside the shape, nothing');
    assert.notEqual(sampleR32(grid, 7.805, 46.295), 0, 'inside it, something');
});
