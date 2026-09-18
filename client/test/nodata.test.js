// Elevation that never was: the fill a cut writes where the survey did not
// reach (server/splatworld/dem.py NODATA_ELEVATION_M), and what reads it.
//
// A tile of pure fill is constant, assemble subtracts the centre sample from
// every height, and the mesh comes out flat at exactly y = 0. The trainer then
// keeps its splats against a box zero metres high and drops every one of a
// finished run — "brush returned 35903 splats and none inside the tile".
import test from 'node:test';
import assert from 'node:assert/strict';

import { allNodata, loadDem, loadDemExact, loadRaster } from '../lib/geo.js';

const raster = (size, fill) => ({ size, data: new Float32Array(size * size).fill(fill) });

// A raster whose left half is fill and right half is ground.
function halfAndHalf(size = 8) {
    const data = new Float32Array(size * size);
    for (let j = 0; j < size; j++) {
        for (let i = size / 2; i < size; i++) data[j * size + i] = 1500 + j;
    }
    return { size, data };
}

test('a window of nothing but fill is no ground', () => {
    assert.ok(allNodata({ ...raster(8, 0), u0: 0, v0: 0, span: 1 }));
});

test('a window with one surveyed sample is ground', () => {
    const r = raster(8, 0);
    r.data[3 * 8 + 4] = 1517.6;
    assert.ok(!allNodata({ ...r, u0: 0, v0: 0, span: 1 }));
});

test('the window is judged, not the file: an ancestor holds ground, this tile none', () => {
    const r = halfAndHalf();
    assert.ok(!allNodata({ ...r, u0: 0, v0: 0, span: 1 }), 'the file as a whole has ground');
    assert.ok(allNodata({ ...r, u0: 0, v0: 0, span: 0.5 }), 'the half this tile reads has none');
    assert.ok(!allNodata({ ...r, u0: 0.5, v0: 0, span: 0.5 }), 'the other half has');
});

test('a window smaller than a pixel still reads the pixel it lands on', () => {
    const r = halfAndHalf();
    assert.ok(allNodata({ ...r, u0: 0, v0: 0, span: 1 / 64 }));
    assert.ok(!allNodata({ ...r, u0: 0.99, v0: 0, span: 1 / 64 }));
});

test('loadRaster passes over an ancestor whose window is all fill', async () => {
    const asked = [];
    const fetchFn = async (url) => {
        asked.push(url);
        // z14's own cut is missing; z12 has ground but not this tile's; z10 has.
        if (url.includes('/14/')) return { status: 404, ok: false };
        return { status: 200, ok: true, arrayBuffer: async () => url };
    };
    const decode = async (url) => (url.includes('/12/') ? raster(8, 0) : halfAndHalf());
    const got = await loadRaster('dem', 14, 8554, 5800, { fetchFn, decode });
    assert.equal(asked.length, 3, 'z14 404, z12 empty here, z10 answered');
    assert.ok(got && !allNodata(got), 'what came back holds ground');
});

test('loadRaster gives up when every ancestor is fill where this tile is', async () => {
    const fetchFn = async () => ({ status: 200, ok: true, arrayBuffer: async () => null });
    const decode = async () => raster(8, 0);
    assert.equal(await loadRaster('dem', 14, 8554, 5800, { fetchFn, decode }), null);
});

test('a mesh gets its own cut or none: no ancestor quilt', async () => {
    // loadRaster walks up two zooms at a time when a tile has not been cut,
    // and the store answers 404 both for a tile outside the world and for one
    // outside the coverage's own envelope (server/splatworld/ground.py
    // "outside the coverage"). So a z14 that missed came back as sixteen of
    // its samples read from z10, stretched over a 513-vertex mesh: the quilt
    // of bilinear triangles a player saw in the frames. `assemble` asks for
    // this tile's own zoom or nothing.
    const asked = [];
    const data = new Float32Array(8 * 8).fill(1800);
    const fetchFn = async (url) => {
        asked.push(String(url));
        return String(url).includes('/dem/14/')
            ? new Response('', { status: 404 })
            : new Response(data.buffer, { status: 200 });
    };
    assert.equal(await loadDemExact(14, 8551, 5812, { fetchFn }), null,
        'a coarser cut is not this tile\u2019s ground');
    assert.equal(asked.length, 1, 'and the ancestors are not even asked for');

    assert.ok(await loadDem(14, 8551, 5812, { fetchFn }),
        'while the floor under a player still takes what it can get');
});
