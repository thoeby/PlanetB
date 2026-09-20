// The ground drawn where nothing is published (client/js/ground.js): which
// tiles are drawn, and what the mesh of one is made of.
import test from 'node:test';
import assert from 'node:assert/strict';

import { DemGround, covered, ringAround, tileGeometry } from '../js/ground.js';
import { tileX, tileY } from '../lib/tilemath.js';
import { key } from '../js/traverse.js';

const row = (z, x, y, published_version) => [key(z, x, y), { z, x, y, published_version }];

test('a published tile, or a published tile above it, covers the ground', () => {
    const tiles = new Map([row(14, 8550, 5809, 1), row(12, 2137, 1451, 0), row(10, 533, 363, 2)]);
    assert.ok(covered(tiles, 14, 8550, 5809), 'published at z14');
    assert.ok(!covered(tiles, 14, 8551, 5809), 'a neighbour that is not');
    assert.ok(covered(tiles, 14, 533 * 16 + 3, 363 * 16 + 5), 'under the published z10');
    assert.ok(!covered(tiles, 14, 8548, 5804), 'an unpublished z12 covers nothing');
});

test('the ground stays under a tile that is published but not yet drawing', () => {
    // Publishing is a row in the database; drawing is bytes in this tab, some
    // seconds later. Taking the ground away on the first leaves the player
    // over nothing until the second.
    const tiles = new Map([row(14, 8550, 5809, 1)]);
    const never = () => false;
    assert.ok(!covered(tiles, 14, 8550, 5809, never), 'published, nothing on screen yet');
    assert.ok(covered(tiles, 14, 8550, 5809, () => true), 'and covered once it draws');
});

test('a published ancestor that is not drawing does not take the ground either', () => {
    const tiles = new Map([row(10, 533, 363, 2)]);
    const here = { x: 533 * 16 + 3, y: 363 * 16 + 5 };
    assert.ok(!covered(tiles, 14, here.x, here.y, () => false), 'the z10 is not on screen');
    assert.ok(covered(tiles, 14, here.x, here.y, (k) => k === key(10, 533, 363)),
        'and it is once it is');
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

// The ground mesh asks the floor for its rasters, and the floor keys them by
// zoom (client/js/floor.js). This asked for `x/y` and got undefined for every
// tile in the world, so no ground was ever built: the whole DEM was invisible
// until something published over it.
test('the ground asks the floor for the tile it means, at the level it means', () => {
    const asked = [];
    const floor = { raster: (...a) => { asked.push(a); return undefined; } };
    const origin = { geodeticOf: () => ({ lon: 7.86, lat: 46.29, h: 0 }) };
    const streamer = { tiles: new Map(), entries: new Map() };
    const mesh = new DemGround(null, null, { origin, floor, streamer });
    mesh.update({ x: 0, y: 0, z: 0 });
    assert.ok(asked.length > 0, 'the floor is asked for the ring around the camera');
    assert.deepEqual(asked[0], [14, tileX(7.86, 14), tileY(46.29, 14)],
        'z14, the tile the camera stands on, first');
    assert.equal(mesh.entities.size, 0, 'and nothing is built until a raster lands');
});

test('cutting the ground again takes the meshes with it', () => {
    const gone = [];
    const mesh = new DemGround(null, null, {
        origin: { geodeticOf: () => ({ lon: 7.86, lat: 46.29, h: 0 }) },
        floor: { raster: () => undefined },
        streamer: { tiles: new Map(), entries: new Map() },
    });
    mesh.entities.set('8557/5736', { destroy: () => gone.push('8557/5736') });
    mesh.rebuild();
    assert.deepEqual(gone, ['8557/5736'], 'the mesh of the old survey is destroyed');
    assert.equal(mesh.entities.size, 0, 'and the next update builds it again');
});

// FND.9: while a land's ground is being shaped it is the mesh that is on
// screen, because the splats over it have been put away (client/js/tiles.js
// hideUnder). So that land's tiles are built as fast as their rasters arrive,
// and built wherever they are — a field at the far end of the ring, or past
// it, is still the field whose mesh is being edited.
function forcedGround(force, { lon = 7.86, lat = 46.29 } = {}) {
    const built = [];
    const mesh = new DemGround(null, null, {
        origin: { geodeticOf: () => ({ lon, lat, h: 0 }) },
        floor: { raster: () => ({ data: new Float32Array(1), size: 1 }) },
        streamer: { tiles: new Map(), entries: new Map() },
    });
    mesh.add = (k) => { built.push(k); mesh.entities.set(k, { destroy: () => {} }); };
    mesh.force = new Set(force);
    return { mesh, built };
}

test('the ground being shaped is built all at once, not one tile a frame', () => {
    const here = { x: tileX(7.86, 14), y: tileY(46.29, 14) };
    const land = [`${here.x}/${here.y}`, `${here.x + 1}/${here.y}`,
        `${here.x}/${here.y + 1}`, `${here.x + 1}/${here.y + 1}`];
    const { mesh, built } = forcedGround(land);
    mesh.update({ x: 0, y: 0, z: 0 });
    for (const k of land) assert.ok(built.includes(k), `${k} was built in the first frame`);
    // And the rest of the ring keeps its one a frame, so walking into a valley
    // does not stall on forty meshes at once.
    assert.equal(built.length, land.length + 1, `${built.length} built`);
});

test('a land past the ring is still drawn while it is being shaped', () => {
    const away = `${tileX(7.86, 14) + 40}/${tileY(46.29, 14) + 40}`;
    const { mesh, built } = forcedGround([away]);
    mesh.update({ x: 0, y: 0, z: 0 });
    assert.ok(built.includes(away), 'the forced tile is built though the ring misses it');
    assert.ok(mesh.entities.has(away), 'and it is not pruned away again');
});
