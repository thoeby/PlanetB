// Elevation that never was: the fill a cut writes where the survey did not
// reach (server/splatworld/dem.py NODATA_ELEVATION_M), and what reads it.
//
// A tile of pure fill is constant, assemble subtracts the centre sample from
// every height, and the mesh comes out flat at exactly y = 0. The trainer then
// keeps its splats against a box zero metres high and drops every one of a
// finished run — "brush returned 35903 splats and none inside the tile".
import test from 'node:test';
import assert from 'node:assert/strict';

import { allNodata, loadRaster } from '../lib/geo.js';

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
