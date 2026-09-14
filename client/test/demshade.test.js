// The ground behind a tool's map. The admin's land map was a dark box with
// outlines floating in it: nothing said which way the valley ran, so a
// boundary could only be drawn against other boundaries.

import test from 'node:test';
import assert from 'node:assert/strict';

import { groundOver, shadeRect, tileOver } from '../lib/demshade.js';
import { DEM_OFFSET, DEM_SCALE } from '../lib/geo.js';
import * as tm from '../lib/tilemath.js';

// A DEM that rises to the east, so the shading is a slope rather than a wash.
function slope(size = 32) {
    const data = new Uint16Array(size * size);
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
            data[j * size + i] = Math.round((900 + i * 30 - DEM_OFFSET) / DEM_SCALE);
        }
    }
    return data;
}

const VISP = { west: 7.84, south: 46.28, east: 7.92, north: 46.32 };

test('the tile asked for is the deepest one that holds the whole rectangle', () => {
    const t = tileOver(VISP);
    assert.ok(t.z >= tm.MIN_ZOOM && t.z <= tm.MAX_ZOOM, `z${t.z}`);
    const b = tm.tileBbox(t.z, t.x, t.y);
    assert.ok(b.west <= VISP.west && b.east >= VISP.east, 'it holds it east to west');
    assert.ok(b.south <= VISP.south && b.north >= VISP.north, 'and north to south');
    // One zoom deeper would not hold it, which is what "deepest" means.
    const deeper = t.z + 2;
    assert.ok(deeper > tm.MAX_ZOOM
        || tm.tileX(VISP.west, deeper) !== tm.tileX(VISP.east, deeper)
        || tm.tileY(VISP.north, deeper) !== tm.tileY(VISP.south, deeper),
    `z${deeper} holds it too, so z${t.z} is not the deepest`);
});

test('a rectangle the world has no ground for shades nothing', async () => {
    const ground = await groundOver(VISP,
        { fetchFn: async () => new Response('', { status: 404 }) });
    assert.equal(ground, null);
    const painted = [];
    assert.equal(shadeRect(fakeCtx(painted), ground,
        { ...VISP, x0: 0, y0: 0, w: 100, h: 100 }), false);
    assert.equal(painted.length, 0, 'and paints nothing rather than a plateau');
});

test('the ground over a rectangle is one request, and metres afterwards', async () => {
    let fetched = 0;
    const ground = await groundOver(VISP, {
        fetchFn: async () => { fetched += 1; return new Response(slope().buffer); },
    });
    assert.equal(fetched, 1, 'one cut tile covers the whole rectangle');
    const west = ground.at(VISP.west + 0.001, 46.3);
    const east = ground.at(VISP.east - 0.001, 46.3);
    assert.ok(west > 800 && west < 2000, `metres above the sea, not counts: ${west}`);
    assert.ok(east > west, 'and the slope runs the way the DEM does');
    assert.equal(ground.at(180, 0), null, 'outside the tile it answers nothing');
});

test('a slope is shaded in more than one colour', async () => {
    const ground = await groundOver(VISP,
        { fetchFn: async () => new Response(slope().buffer) });
    const painted = [];
    const drew = shadeRect(fakeCtx(painted), ground,
        { ...VISP, x0: 12, y0: 12, w: 396, h: 276 });
    assert.equal(drew, true);
    assert.ok(painted.length > 100, `shaded cell by cell: ${painted.length}`);
    assert.ok(new Set(painted.map((c) => c.fill)).size > 3,
        'a slope is not one colour');
    assert.ok(painted.every((c) => c.x >= 12 && c.y >= 12),
        'and it starts where the map does, not at the canvas corner');
});

function fakeCtx(painted) {
    return {
        fillStyle: '',
        save() {},
        restore() {},
        beginPath() {},
        rect() {},
        clip() {},
        fillRect(x, y, w, h) { painted.push({ x, y, w, h, fill: this.fillStyle }); },
    };
}
