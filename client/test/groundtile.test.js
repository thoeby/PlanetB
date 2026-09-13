// The ground under the player, and the ground twenty kilometres behind it.
//
// client/lib/groundtile.js is a pure function of a DEM, so the two things that
// are hard to see in a 3D view — that a coarse tile leaves a hole where a finer
// one is drawing, and that every edge of what it did draw has a skirt under it
// — are checked here instead.

import assert from 'node:assert/strict';
import test from 'node:test';

import { cellMetres, groundTile, heightIn } from '../lib/groundtile.js';
import { blockAt, GROUND_LEVELS, holeFor } from '../lib/groundmesh.js';
import { DEM_OFFSET, DEM_SCALE } from '../lib/geo.js';

// A DEM that rises to the east, so a hole in the mesh is not a hole in a plane.
function slope(size = 32) {
    const data = new Uint16Array(size * size);
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
            data[j * size + i] = Math.round((1000 + i * 20 - DEM_OFFSET) / DEM_SCALE);
        }
    }
    return { kind: 'dem', size, data, u0: 0, v0: 0, span: 1 };
}

// The floating origin, flattened: metres east and north of the tile's corner.
const localOf = ({ lon, lat, h }) => ({ x: lon * 111320, y: h, z: -lat * 111320 });

const Z = 14;
const X = 8574;
const Y = 5850;

test('a tile with no hole is one quad per cell, and a skirt all round it', () => {
    const grid = 9;
    const tile = groundTile(Z, X, Y, slope(), localOf, grid);
    const cells = (grid - 1) * (grid - 1);
    const border = (grid - 1) * 4;
    assert.equal(tile.indices.length, (cells * 2 + border * 2) * 3,
        'two triangles a cell, and two more for every step of the border');
    assert.equal(tile.positions.length / 3, grid * grid + border * 2,
        'the skirt is its own vertices, hanging below the ones it copies');
});

test('the skirt hangs below the surface, not above it', () => {
    const grid = 9;
    const tile = groundTile(Z, X, Y, slope(), localOf, grid);
    const surface = [];
    for (let k = 0; k < grid * grid; k++) surface.push(tile.positions[k * 3 + 1]);
    const lowest = Math.min(...surface);
    const skirts = [];
    for (let k = grid * grid; k < tile.positions.length / 3; k++) {
        skirts.push(tile.positions[k * 3 + 1]);
    }
    assert.ok(Math.max(...skirts) < Math.max(...surface));
    assert.ok(Math.min(...skirts) < lowest, 'and reaches below the whole tile');
});

test('a hole in the middle takes those cells out and hems what is left', () => {
    const grid = 9;
    const b = { west: -180 + X / 2 ** Z * 360, east: -180 + (X + 1) / 2 ** Z * 360 };
    const whole = groundTile(Z, X, Y, slope(), localOf, grid);
    const mid = (b.west + b.east) / 2;
    const wide = (b.east - b.west) / 6;
    const holed = groundTile(Z, X, Y, slope(), localOf, grid,
        { hole: { west: mid - wide, east: mid + wide, south: -90, north: 90 } });
    assert.ok(holed.indices.length < whole.indices.length,
        'fewer triangles: the cells inside the hole are not drawn');
    assert.ok(holed.positions.length > grid * grid * 3,
        'and the hole has a skirt of its own round it');
});

test('a hole that covers everything draws nothing at all', () => {
    const tile = groundTile(Z, X, Y, slope(), localOf, 9,
        { hole: { west: -180, east: 180, south: -90, north: 90 } });
    assert.equal(tile.indices.length, 0);
});

test('height is read off the samples whatever the hole is', () => {
    const grid = 9;
    const tile = groundTile(Z, X, Y, slope(), localOf, grid,
        { hole: { west: -180, east: 180, south: -90, north: 90 } });
    const { west, east } = tile.bbox;
    const west_ = heightIn(tile, west + (east - west) * 0.1, tile.bbox.south + 0.001);
    const east_ = heightIn(tile, west + (east - west) * 0.9, tile.bbox.south + 0.001);
    assert.ok(east_ > west_, 'the DEM rises to the east and the samples say so');
});

test('a cell of a coarse tile is hundreds of metres and of a fine one is tens', () => {
    assert.ok(cellMetres(14, 65, 46) < 40, `${cellMetres(14, 65, 46)} m`);
    assert.ok(cellMetres(10, 65, 46) > 300, `${cellMetres(10, 65, 46)} m`);
});

test('each level leaves a hole the one above it fills, pulled in by a cell', () => {
    const [fine, mid] = GROUND_LEVELS;
    const inner = blockAt(fine, 7.88, 46.29).rect;
    const hole = holeFor(mid, inner);
    assert.ok(hole.west > inner.west && hole.east < inner.east,
        'the hole is inside what the finer level draws, never wider than it');
    assert.ok(hole.south > inner.south && hole.north < inner.north);
});

test('the far level reaches tens of kilometres, the near one a walk', () => {
    const near = blockAt(GROUND_LEVELS[0], 7.88, 46.29).rect;
    const far = blockAt(GROUND_LEVELS.at(-1), 7.88, 46.29).rect;
    const km = (r) => (r.east - r.west) * 111.32 * Math.cos(46.29 * Math.PI / 180);
    assert.ok(km(near) > 3 && km(near) < 8, `near ring is ${km(near)} km`);
    assert.ok(km(far) > 25, `far ring is ${km(far)} km`);
});

// The edge of the world. A tile at z10 is twenty-seven kilometres across and
// an operator's coverage is often four, so most of a coarse tile at the edge
// is ground nobody has — which comes back as sea level, and drawing it puts a
// plateau at zero metres around a world that starts at six hundred.
test('no ground is drawn past the edge of the coverage', () => {
    const grid = 9;
    const b = { west: -180 + X / 2 ** Z * 360, east: -180 + (X + 1) / 2 ** Z * 360 };
    const whole = groundTile(Z, X, Y, slope(), localOf, grid);
    const half = groundTile(Z, X, Y, slope(), localOf, grid, {
        within: { west: b.west, east: (b.west + b.east) / 2, south: -90, north: 90 },
    });
    assert.ok(half.indices.length < whole.indices.length,
        'the half outside the coverage is not drawn');
    assert.ok(half.indices.length > 0, 'and the half inside it is');
});

test('a tile wholly outside the coverage draws nothing', () => {
    const tile = groundTile(Z, X, Y, slope(), localOf, 9,
        { within: { west: -10, east: -9, south: -10, north: -9 } });
    assert.equal(tile.indices.length, 0);
});

test('with no coverage given, the whole tile is drawn', () => {
    const a = groundTile(Z, X, Y, slope(), localOf, 9);
    const b = groundTile(Z, X, Y, slope(), localOf, 9, { within: null });
    assert.equal(a.indices.length, b.indices.length);
});
