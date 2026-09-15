// The ground under the player, and the ground twenty kilometres behind it.
//
// client/lib/groundtile.js is a pure function of a DEM, so the two things that
// are hard to see in a 3D view — that a coarse tile leaves a hole where a finer
// one is drawing, and that every edge of what it did draw has a skirt under it
// — are checked here instead.

import assert from 'node:assert/strict';
import test from 'node:test';

import { cellMetres, groundTile, heightIn } from '../lib/groundtile.js';
import { blockAt, Ground, GROUND_LEVELS, holeFor } from '../lib/groundmesh.js';

// A DEM that rises to the east, so a hole in the mesh is not a hole in a plane.
function slope(size = 32) {
    const data = new Float32Array(size * size);
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
            data[j * size + i] = 1000 + i * 20;
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
    assert.ok(km(near) > 0.8 && km(near) < 2, `near ring is ${km(near)} km`);
    assert.ok(km(far) > 25, `far ring is ${km(far)} km`);
});

// The line between ground somebody stands on and a picture of the distance.
// Both fine levels are tens of centimetres to tens of metres a cell; the
// coarse ones are hundreds, and walking on one would put a player in the air
// or under the hill.
test('the levels a player may stand on are the fine ones and no others', () => {
    const zooms = new Ground({ origin: { localOf: () => ({}) } })
        .standable().map((l) => l.zoom);
    assert.deepEqual(zooms, [16, 14]);
    assert.ok(cellMetres(16, 129, 46) < 4, `${cellMetres(16, 129, 46)} m at z16`);
    assert.ok(cellMetres(12, 65, 46) > 100, `${cellMetres(12, 65, 46)} m at z12`);
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

// Walking. The finest ring is 420 m across, so a few hundred metres of it puts
// you in the next z16 tile, which moves the hole every level behind it has to
// leave — and every one of those was thrown away and asked for again. The
// samples are on the tile, so the new shape is arithmetic.
test('crossing into the next fine tile reshapes the coarse ones, not refetches them', async () => {
    let fetched = 0;
    const dem = slope();
    const ground = new Ground({
        origin: { localOf },
        fetchFn: async () => { fetched += 1; return new Response(dem.data.buffer); },
        // One fine level and one behind it is the whole shape of the problem.
        levels: [{ zoom: 16, grid: 9, radius: 1 }, { zoom: 14, grid: 9, radius: 1 }],
    });
    const settle = async () => {
        for (let i = 0; i < 40; i++) {
            ground.follow(7.8800, 46.2900);
            await new Promise((r) => setTimeout(r, 0));
        }
    };
    await settle();
    const first = fetched;
    const coarse = [...ground.tiles.values()].filter((t) => t.z === 14);
    assert.ok(coarse.length > 0, 'the level behind is drawn');

    // Half a kilometre east: the same z14 tiles, the next z16 one.
    for (let i = 0; i < 40; i++) {
        ground.follow(7.8865, 46.2900);
        await new Promise((r) => setTimeout(r, 0));
    }
    const still = [...ground.tiles.values()].filter((t) => t.z === 14);
    assert.ok(still.length > 0, 'the level behind is still drawn');
    assert.ok(fetched - first < coarse.length,
        `the coarse tiles were reshaped, not refetched: ${fetched - first} new fetches`);
});

// The ground a player stands on is every level fine enough to be a floor, and
// all of it has to be on its way at once. The ray that finds the ground under
// a click reaches four hundred metres — further than the z16 ring — so making
// z14 queue behind z16 shortened the world to whatever the fine ring covered,
// and a click past that put nothing down.
test('every level fine enough to stand on is asked for at once', async () => {
    const asked = [];
    const dem = slope();
    const ground = new Ground({
        origin: { localOf },
        fetchFn: (url) => {
            asked.push(url);
            // The fine ring never answers at all — not a failure, which counts
            // as settled (`settled()`), but still in the air.
            if (url.includes('/16/')) return new Promise(() => {});
            return Promise.resolve(new Response(dem.data.buffer));
        },
    });
    for (let i = 0; i < 40; i++) {
        ground.follow(7.88, 46.29);
        await new Promise((r) => setTimeout(r, 0));
    }
    assert.ok(asked.some((u) => u.includes('/16/')), 'the fine ring is asked for');
    assert.ok([...ground.tiles.values()].some((t) => t.z === 14),
        'and the level behind it arrives even though the fine one has not');
    assert.ok(!asked.some((u) => u.includes('/10/')),
        'while the far ones still wait for the floor');
});
