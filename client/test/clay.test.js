// EDT.1 — Blueprint's ground: the clay's colour by slope and light, the
// overlays that tint it, and the chunked grid it is drawn on.
import test from 'node:test';
import assert from 'node:assert/strict';

import { DIM, GREY_AT, SUN, WARM_AT, changedTint, clayAt, hatched, litBy, normalOf,
    vertexColour } from '../lib/clay.js';
import { CHUNK, chunkGeometry, chunksIn, chunksOf, geodetic, heightIn, layout, local,
    slopeAt } from '../lib/bpgrid.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('flat clay is white, steep clay goes grey and then warm', () => {
    const flat = clayAt(0);
    assert.ok(flat.every((q) => q > 0.9), `flat is ${flat}`);
    const grey = clayAt(GREY_AT);
    assert.ok(Math.max(...grey) - Math.min(...grey) < 0.01, 'grey has no hue');
    assert.ok(grey[0] < flat[0]);
    const warm = clayAt(WARM_AT + 10);
    assert.ok(warm[0] > warm[2] + 0.3, `past ${WARM_AT}° it is warm: ${warm}`);
    // Monotone in brightness up to the grey.
    let was = 2;
    for (let s = 0; s <= GREY_AT; s += 2) {
        const b = clayAt(s)[1];
        assert.ok(b <= was + 1e-9);
        was = b;
    }
});

test('the light comes from the north-west and never leaves a face black', () => {
    assert.ok(SUN[0] < 0 && SUN[2] < 0 && SUN[1] > 0, 'west, north, above');
    assert.ok(close(Math.hypot(...SUN), 1));
    const towards = normalOf(10, 0, 10, 0, 1, 1);   // falls to the east and south
    const away = normalOf(0, 10, 0, 10, 1, 1);
    assert.ok(litBy(away.nx, away.ny, away.nz) > litBy(towards.nx, towards.ny, towards.nz));
    assert.ok(litBy(towards.nx, towards.ny, towards.nz) >= 0.5);
});

test('slope is degrees off the level', () => {
    assert.ok(close(normalOf(0, 0, 0, 0, 1, 1).slope, 0));
    // One metre up per metre across is 45°.
    assert.ok(close(normalOf(0, 2, 0, 0, 1, 1).slope, 45, 1e-9));
});

test('what you changed is blue above, red below, nothing where untouched', () => {
    assert.equal(changedTint(0), null);
    assert.equal(changedTint(0.004), null);
    const up = changedTint(1);
    const down = changedTint(-1);
    assert.ok(up.colour[2] > up.colour[0], 'raised is blue');
    assert.ok(down.colour[0] > down.colour[2], 'lowered is red');
    assert.ok(changedTint(3).alpha > changedTint(0.5).alpha, 'further off, stronger');
    assert.equal(hatched(0, 0), true);
    assert.equal(hatched(3, 0), false);
});

test('everybody else is 60 % darker, and the steep overlay marks steep ground', () => {
    const base = { slope: 5, lit: 1, i: 0, j: 0, delta: 0, changed: true };
    const mine = vertexColour({ ...base, inside: true });
    const theirs = vertexColour({ ...base, inside: false });
    mine.forEach((q, k) => assert.ok(close(theirs[k], q * DIM)));
    const steep = vertexColour({ ...base, slope: 40, inside: true, steep: 35 });
    const plain = vertexColour({ ...base, slope: 40, inside: true, steep: 0 });
    assert.notDeepEqual(steep, plain);
    const moved = vertexColour({ ...base, inside: true, delta: 2 });
    assert.ok(moved[2] > moved[0], 'raised ground reads blue');
    const off = vertexColour({ ...base, inside: true, delta: 2, changed: false });
    assert.deepEqual(off, mine, 'the switch turns it off');
});

const L = layout([7.88, 46.29, 7.89, 46.30], 0.3);

test('the grid is no finer than the land and no wider than it may be', () => {
    assert.ok(L.cols <= 641 && L.rows <= 641);
    assert.ok(L.step >= 0.3);
    const p = local(L, 7.885, 46.295, 700, 650);
    assert.ok(close(p.x, 0, 1e-6) && close(p.z, 0, 1e-6) && close(p.y, 50, 1e-6));
    const g = geodetic(L, local(L, 7.881, 46.299, 720, 650), 650);
    assert.ok(close(g.lon, 7.881, 1e-9) && close(g.lat, 46.299, 1e-9) && close(g.h, 720, 1e-6));
    // North is -z, east is +x: the scene's frame.
    assert.ok(local(L, 7.885, 46.299, 0).z < 0);
    assert.ok(local(L, 7.889, 46.295, 0).x > 0);
});

test('chunks tile the grid and share their edges', () => {
    const cs = chunksOf(L);
    const cover = new Set();
    for (const c of cs) {
        assert.ok(c.i1 - c.i0 <= CHUNK && c.j1 - c.j0 <= CHUNK);
        for (let j = c.j0; j <= c.j1; j++) {
            for (let i = c.i0; i <= c.i1; i++) cover.add(j * L.cols + i);
        }
    }
    assert.equal(cover.size, L.cols * L.rows);
    assert.equal(chunksIn(cs, 2, 2, 60, 60).length, 1);
    assert.ok(chunksIn(cs, 60, 60, 70, 70).length >= 4);
});

test('a chunk is heights, normals and colours, with a skirt; 64² is quick', () => {
    const heights = new Float32Array(L.cols * L.rows).map((_, k) => 600 + (k % L.cols) * 0.1);
    const c = chunksOf(L)[0];
    const colour = (k, i, j, slope, lit) => vertexColour({ slope, lit, inside: true, delta: 0 });
    const g = chunkGeometry(L, heights, c, colour, { h0: 600, skirt: 2 });
    const n = (c.i1 - c.i0 + 1) * (c.j1 - c.j0 + 1);
    const ring = 2 * ((c.i1 - c.i0 + 1) + (c.j1 - c.j0 + 1)) - 4;
    assert.equal(g.positions.length, (n + ring) * 3);
    assert.equal(g.indices.length, ((c.i1 - c.i0) * (c.j1 - c.j0) + ring) * 6);
    assert.ok(Math.max(...g.indices) < n + ring);
    assert.ok(close(g.positions[(n) * 3 + 1], g.positions[1] - 2, 1e-4), 'the skirt hangs');
    const t = performance.now();
    for (let r = 0; r < 10; r++) chunkGeometry(L, heights, c, colour, { h0: 600, skirt: 2 });
    const each = (performance.now() - t) / 10;
    assert.ok(each < 8, `one 64² chunk takes ${each.toFixed(2)} ms`);
    assert.ok(slopeAt(L, heights, 5, 5) > 0);
    assert.ok(close(heightIn(L, heights, 1.5, 0), 600.15, 1e-3));
});
