// WP2.3 — assemble without a browser: the same inputs and the same seed
// produce the same bytes, and what comes out is the five files the rest of the
// pipeline reads. The world and the DEM are served from memory, so this test
// needs neither a database nor a seeded store.
//
// FND.3 moved the vocabulary to OSM's — a road is `highway=secondary`, a wood
// is `landuse=forest` — and the fixture below is written in it. Nothing the
// compiler draws changed, and the last test in this file is what says so: it
// holds the hashes `assemble-v5` produced from the same world in the old
// vocabulary, and the new compiler has to match them exactly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

import { run } from '../atoms/assemble.js';
import { readTar } from '../lib/tar.js';
import { readPly } from '../lib/ply.js';
import { earcut, ringArea, scatter, rng } from '../lib/poly.js';
import { tileBbox } from '../lib/tilemath.js';

const Z = 16;
const X = 34222;
const Y = 22946;
const BUDGET = 20000;
const B = tileBbox(Z, X, Y);

// A hill with a step in it, in dem-v1 counts: elevation_m = value * 0.2 - 500.
function demTile(size = 256) {
    const data = new Uint16Array(size * size);
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
            const e = 400 + 30 * Math.sin(i / 19) * Math.cos(j / 23) + (i > size / 2 ? 12 : 0);
            data[j * size + i] = Math.round((e + 500) / 0.2);
        }
    }
    return Buffer.from(data.buffer);
}

// Somewhere inside the tile, as a fraction of its width and height.
const at = (u, v) => [B.west + (B.east - B.west) * u, B.north + (B.south - B.north) * v];

const box = (u, v, w, h) => [[at(u, v), at(u + w, v), at(u + w, v + h),
    at(u, v + h), at(u, v)]];

const WORLD = {
    z: Z, x: X, y: Y, snapshot: 'a'.repeat(64), instances: [],
    features: [
        { id: '1', kind: 'building', rev: 1, props: { building: 'house', height: 14,
            roof: 'gabled' },
        geom: { type: 'Polygon', coordinates: box(0.30, 0.30, 0.004, 0.004) } },
        { id: '2', kind: 'building', rev: 1, props: { building: 'house', levels: 2 },
            geom: { type: 'Polygon', coordinates: box(0.40, 0.30, 0.003, 0.003) } },
        { id: '3', kind: 'landuse', rev: 1, props: { landuse: 'forest',
            leaf_type: 'broadleaved' },
        geom: { type: 'Polygon', coordinates: box(0.55, 0.55, 0.2, 0.2) } },
        { id: '4', kind: 'natural', rev: 1, props: { natural: 'water' },
            geom: { type: 'Polygon', coordinates: box(0.1, 0.6, 0.15, 0.1) } },
        { id: '5', kind: 'highway', rev: 1, props: { highway: 'secondary', width: 9 },
            geom: { type: 'LineString',
                coordinates: [at(0.05, 0.2), at(0.5, 0.25), at(0.95, 0.4)] } },
        { id: '6', kind: 'terrainmod', rev: 1, props: { op: 'flatten', amount: 0 },
            geom: { type: 'Polygon', coordinates: box(0.7, 0.1, 0.1, 0.1) } },
    ],
    // The symbols travel with the world (db/0139). These are the migrated
    // ones this fixture needs — each the single layer that reproduces the
    // rule it came from: a building's height off its own column, a road's
    // width off its own, a flattening terrainmod, a stand of trees, a lake.
    symbols: [
        { name: 'any building', kind: 'building', ordering: 999, enabled: true, filter: [],
            layers: [{ layer: 'extrude', params: { roof: 'flat',
                height: { prop: 'height', else: { prop: 'levels', times: 3, else: 6 } } } }] },
        { name: 'any road', kind: 'highway', ordering: 999, enabled: true, filter: [],
            layers: [{ layer: 'surface',
                params: { width: { prop: 'width', min: 2, max: 40, else: 5 } } }] },
        { name: 'any terrainmod', kind: 'terrainmod', ordering: 999, enabled: true, filter: [],
            layers: [{ layer: 'terrainmod', params: { amount: { prop: 'amount', else: 0 },
                op: { prop: 'op', text: true, else: 'flatten' } } }] },
        { name: 'any forest', kind: 'landuse', ordering: 999, enabled: true,
            filter: [{ op: 'in', prop: 'landuse', value: ['forest'] }],
            layers: [{ layer: 'scatter', params: { height: [12, 22], sides: 6,
                taper: 0.28, mature: 70, age_prop: 'age' } }] },
        { name: 'water', kind: 'natural', ordering: 999, enabled: true,
            filter: [{ op: 'in', prop: 'natural', value: ['water'] }],
            layers: [{ layer: 'surface', params: {} }] },
    ],
};

async function serve() {
    const dem = demTile();
    const server = createServer((req, res) => {
        if (req.url.startsWith('/rpc/tile_world')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(WORLD));
        } else if (req.url.startsWith('/geo/dem/')) {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            res.end(dem);
        } else {
            res.writeHead(404).end();
        }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    return { url, stop: () => server.close() };
}

const ATOM = {
    id: 1, op: 'assemble', algo_version: 'assemble-v6', seed: 7,
    inputs: { snapshot: WORLD.snapshot }, params: { z: Z, x: X, y: Y, budget: BUDGET },
};

const sha = (b) => createHash('sha256').update(b).digest('hex');

test('assemble produces the five files the rest of the pipeline reads', async () => {
    const s = await serve();
    try {
        const out = await run({ atom: ATOM, apiUrl: s.url, filesUrl: s.url });
        const files = readTar(out.files[0].bytes);
        assert.deepEqual([...files.keys()],
            ['scene.json', 'mesh.bin', 'init.ply', 'height.r16', 'colliders.json']);

        const scene = JSON.parse(new TextDecoder().decode(files.get('scene.json')));
        assert.equal(scene.algo, 'assemble-v6');
        assert.deepEqual(scene.tile, { z: Z, x: X, y: Y });
        assert.ok(scene.origin.h > 350 && scene.origin.h < 460, 'the origin sits on the ground');
        assert.ok(scene.meshes.length >= 6, 'terrain, road, walls, roofs, water, trees');

        const ply = readPly(files.get('init.ply'));
        assert.equal(ply.count, Math.round(BUDGET * 0.3));
        assert.equal(out.result.splat_count, ply.count);
        assert.ok(ply.x.every(Number.isFinite) && ply.y.every(Number.isFinite));

        assert.equal(files.get('height.r16').length, scene.height.size ** 2 * 2);
        const colliders = JSON.parse(new TextDecoder().decode(files.get('colliders.json')));
        assert.equal(colliders.boxes.length, 2, 'one box per footprint');
        assert.ok(colliders.boxes[0].half[1] > 6, 'a 14 m building is 14 m tall');
        assert.ok(out.result.trees > 10, `trees were scattered, got ${out.result.trees}`);
    } finally { s.stop(); }
});

test('the same atom twice is the same bytes', async () => {
    const s = await serve();
    try {
        const a = await run({ atom: ATOM, apiUrl: s.url, filesUrl: s.url });
        const b = await run({ atom: ATOM, apiUrl: s.url, filesUrl: s.url });
        assert.equal(sha(a.files[0].bytes), sha(b.files[0].bytes),
            'Invariant 2: same inputs, same seed, same artifact');
        const other = await run({
            atom: { ...ATOM, seed: 8 }, apiUrl: s.url, filesUrl: s.url,
        });
        assert.notEqual(sha(a.files[0].bytes), sha(other.files[0].bytes),
            'and a different seed is a different scatter');
    } finally { s.stop(); }
});

test('an atom built from a different world refuses to run', async () => {
    const s = await serve();
    try {
        await assert.rejects(() => run({
            atom: { ...ATOM, inputs: { snapshot: 'b'.repeat(64) } },
            apiUrl: s.url, filesUrl: s.url,
        }), /the world moved/);
    } finally { s.stop(); }
});

test('a ring is triangulated, wound and scattered the same way every time', () => {
    const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
    assert.equal(ringArea(square), -100, 'clockwise in x/z is negative');
    assert.equal(earcut(square).length, 6, 'two triangles');

    const l = [[0, 0], [20, 0], [20, 5], [5, 5], [5, 20], [0, 20]];
    assert.equal(earcut(l).length, 12, 'a concave hexagon is four triangles');

    const holed = [[[0, 0], [40, 0], [40, 40], [0, 40]], [[10, 10], [30, 10], [30, 30], [10, 30]]];
    const pts = scatter(holed, 4, rng(1));
    assert.ok(pts.length > 20, `scatter filled the ring, got ${pts.length}`);
    assert.ok(!pts.some(([x, z]) => x > 10 && x < 30 && z > 10 && z < 30),
        'and left the hole alone');
    assert.deepEqual(scatter(holed, 4, rng(1)), pts, 'same seed, same trees');
});


// The same world, drawn the same way. These two hashes were produced by
// `assemble-v5` — the compiler as it stood at bbf9e77, before FND.3 — over
// this same fixture written in the old vocabulary: road, forest, water,
// footprint, with rules keyed on those kinds. db/0135 renames the kinds and
// moves what used to be the kind into a property; `by(kind, key, values)` in
// assemble.js reads the new shape. If a single triangle or splat moves, this
// is what notices.
const BEFORE_FND3 = {
    mesh: 'f7d2a23134b5c7b3d336c73f8e1a4bfd6250422ffbd6dc4fc18f7356dd3cf6e1',
    ply: 'c488cd8c0c1403c7fa2eacfdb6df2bcf5ff054825a6b31a3423ae726f0a65a8f',
    trees: 118,
};

test('the OSM vocabulary draws what the old one drew, to the byte', async () => {
    const s = await serve();
    try {
        const out = await run({ atom: ATOM, apiUrl: s.url, filesUrl: s.url });
        const files = readTar(out.files[0].bytes);
        assert.equal(sha(files.get('mesh.bin')), BEFORE_FND3.mesh,
            'the geometry is the same geometry');
        assert.equal(sha(files.get('init.ply')), BEFORE_FND3.ply,
            'and so is what the trainer starts from');
        assert.equal(out.result.trees, BEFORE_FND3.trees, 'the same trees, in the same places');
    } finally { s.stop(); }
});
