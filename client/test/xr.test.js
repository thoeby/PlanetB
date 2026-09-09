// WP5.4 — what XR changes, without a headset: the budget the streamer is given
// and where a teleport lands. The session itself is a button press on a device
// and is documented rather than tested (docs/xr.md).

import test from 'node:test';
import assert from 'node:assert/strict';

import * as tm from '../lib/tilemath.js';
import { FloatingOrigin } from '../js/origin.js';
import { LIMITS, key, selectTiles } from '../js/tiles.js';
import { XR_LIMITS, limitsFor, teleportTarget, xrRequested, xrSupported }
    from '../js/xr.js';

// A ground plane at y = 100, and nothing outside a 500 m square: heightAt
// answers null off the streamed world, the way client/js/player.js's Terrain
// does when the tile under the player has not arrived.
const plane = (h = 100, half = 500) => ({
    heightAt: (p) => (Math.abs(p.x) <= half && Math.abs(p.z) <= half ? h : null),
});

test('?xr=1 is the only thing that asks for a headset', () => {
    assert.equal(xrRequested('?xr=1'), true);
    assert.equal(xrRequested('?xr=1&debug=1'), true);
    assert.equal(xrRequested('?xr=0'), false);
    assert.equal(xrRequested(''), false);
});

test('a browser with no runtime is not an error', async () => {
    assert.equal(await xrSupported({}), false);
    assert.equal(await xrSupported({ xr: {} }), false);
    assert.equal(await xrSupported({ xr: { isSessionSupported: async () => true } }), true);
    assert.equal(await xrSupported(
        { xr: { isSessionSupported: async () => { throw new Error('no'); } } }), false);
});

test('XR holds a third of the desktop budget, and hands it back on the way out', () => {
    assert.ok(XR_LIMITS.splats <= 8e6, 'TASKS.md WP5.4: 8 M splats');
    assert.ok(XR_LIMITS.tiles < LIMITS.tiles);
    assert.deepEqual(limitsFor(true, LIMITS), XR_LIMITS);
    assert.deepEqual(limitsFor(false, LIMITS), LIMITS);
});

test('the streamer keeps what the XR budget allows and no more', () => {
    // Twelve z6 roots of two million splats each, all of them in view: enough
    // that the budget is what decides, not the traversal.
    const rows = [];
    for (let i = 0; i < 12; i++) {
        const z = tm.MIN_ZOOM;
        const x = 33 + i;
        const y = 22;
        rows.push({ z, x, y, published_version: 1, sog_sha256: 'a'.repeat(64),
            manifest: { origin: tm.tileFrame(z, x, y, 0), splats: 2e6,
                geometric_error_m: 5000 } });
    }
    const world = {
        tiles: new Map(rows.map((r) => [key(r.z, r.x, r.y), r])),
        roots: rows,
        origin: new FloatingOrigin(tm.tileFrame(tm.MIN_ZOOM, 33, 22, 0)),
        loaded: new Map(),
        inflight: 0,
    };
    const camera = { position: { x: 0, y: 3e6, z: 0 }, planes: null, screenH: 1080,
        fovY: 45 * tm.RAD_PER_DEG };
    const desktop = selectTiles(world, camera, LIMITS);
    const xr = selectTiles(world, camera, XR_LIMITS);
    assert.equal(desktop.want.size, 12, 'the desktop budget holds all of them');
    assert.equal(xr.want.size, 4, '8 M splats is four of these tiles');
    assert.ok(xr.load.length <= XR_LIMITS.inflight, 'and it loads them two at a time');
});

test('a teleport lands on the ground, with the eyes above it', () => {
    const from = { x: 0, y: 130, z: 0 };
    const hit = teleportTarget(plane(100), from, { x: 0, y: -1, z: 0 });
    assert.ok(Math.abs(hit.ground - 100) < 0.5, `ground ${hit.ground}`);
    assert.ok(Math.abs(hit.y - hit.ground - 1.7) < 1e-9, 'standing height, not sunk in');
    assert.ok(Math.abs(hit.x) < 0.5 && Math.abs(hit.z) < 0.5);
});

test('a teleport at the sky, or past its reach, lands nowhere', () => {
    const t = plane(100);
    assert.equal(teleportTarget(t, { x: 0, y: 130, z: 0 }, { x: 0, y: 1, z: 0 }), null);
    // Ground 200 m below, and the ray may only reach 120.
    assert.equal(teleportTarget(t, { x: 0, y: 300, z: 0 }, { x: 0, y: -1, z: 0 }), null);
    // Off the streamed world: heightAt says null and so does the teleport.
    assert.equal(teleportTarget(t, { x: 900, y: 130, z: 0 }, { x: 0, y: -1, z: 0 }), null);
});
