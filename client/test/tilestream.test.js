// tilestream.test.js — the streamer's bookkeeping, with enough of PlayCanvas to
// watch it: what is in flight, what is swapped for a newer version, and what is
// released. Split out of client/test/tiles.test.js, which is the traversal.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as tm from '../lib/tilemath.js';
import { FloatingOrigin } from '../js/origin.js';
import { POLL_MS, RETRY_MS, TileStreamer } from '../js/tiles.js';

// The tiles tools/make-test-tiles.mjs publishes, with the manifests it writes.
const GRID = { 6: 24, 8: 32, 10: 48 };
const COORDS = [[10, 535, 361], [10, 535, 362], [10, 536, 361], [10, 536, 362],
    [8, 133, 90], [8, 134, 90], [6, 33, 22]];

function row(z, x, y, published = true) {
    const o = tm.tileFrame(z, x, y, 0);
    const b = tm.tileBbox(z, x, y);
    const span = tm.localFromLonLat(o, b.east, b.north).x
        - tm.localFromLonLat(o, b.west, b.north).x;
    return {
        z, x, y,
        published_version: published ? 1 : 0,
        sog_sha256: published ? 'a'.repeat(64) : null,
        manifest: {
            origin: o, splats: GRID[z] ** 2, geometric_error_m: span / GRID[z],
        },
    };
}

const camera = (y, planes = null) => ({
    position: { x: 0, y, z: 0 }, planes, screenH: 1080, fovY: 45 * tm.RAD_PER_DEG,
});

// An outgoing entity is disabled now and destroyed a tick later (tiles.js release()).
const tick = () => new Promise((r) => setTimeout(r, 0));

//
// Enough of PlayCanvas to watch the streamer's bookkeeping: loading an asset
// runs its ready callbacks straight away, so a swap completes within the call.
// With `manual`, loads queue on app.loads and the test fires them: ready, or
// error for an asset the `fail` predicate picks out.

function fakePc() {
    return {
        Asset: class {
            constructor(name, type, file) {
                Object.assign(this, { name, type, file, ready_: [], once_: {}, unloads: 0 });
            }
            ready(fn) { this.ready_.push(fn); }
            once(ev, fn) { this.once_[ev] = fn; }
            unload() { this.unloaded = true; this.unloads++; }
        },
        Entity: class {
            constructor(name) { this.name = name; }
            addComponent(kind, data) { this[kind] = data; }
            setLocalPosition() { /* placement is covered by the browser tests */ }
            setLocalRotation() { }
            destroy() { this.destroyed = true; }
        },
    };
}

function fakeApp({ manual = false, fail = () => false } = {}) {
    const app = {
        root: { addChild() {} },
        loads: [],
        fire: (a) => (fail(a) ? a.once_.error?.('boom') : a.ready_.forEach((fn) => fn())),
    };
    app.assets = { add() {}, remove() {}, load: (a) => (manual ? app.loads.push(a) : app.fire(a)) };
    return app;
}

function streamerWith(rows, fetchRows, appOpts) {
    const origin = new FloatingOrigin(tm.tileFrame(10, 535, 361, 0));
    const s = new TileStreamer(fakeApp(appOpts), fakePc(), {
        origin, filesUrl: 'http://files', fetchRows,
    });
    s.setTiles(rows);
    return s;
}

const swapRow = (r, sha) => ({ ...r, published_version: r.published_version + 1, sog_sha256: sha });

test('the poll interval is the 30 s WP1.5 asks for', () => {
    assert.equal(POLL_MS, 30000);
});

test('an unchanged tile is not swapped', async () => {
    const rows = COORDS.map((c) => row(...c));
    const s = streamerWith(rows, async () => rows);
    s.entries.set('10/535/361', { row: rows[0], entity: null, asset: null, usedAt: 1 });
    assert.equal(await s.poll(), 0);
    assert.equal(s.swaps, 0);
});

test('a republished tile is swapped and the old entity disposed', async () => {
    const rows = COORDS.map((c) => row(...c));
    const fresh = swapRow(rows[0], 'b'.repeat(64));
    const s = streamerWith(rows, async () => [fresh, ...rows.slice(1)]);
    const old = { destroyed: false, destroy() { this.destroyed = true; } };
    const oldAsset = { unloaded: false, unload() { this.unloaded = true; } };
    const entry = { row: rows[0], entity: old, asset: oldAsset, usedAt: 1 };
    s.entries.set('10/535/361', entry);

    assert.equal(await s.poll(), 1);
    assert.equal(s.swaps, 1);
    assert.equal(old.enabled, false, 'the old entity leaves the scene at once');
    await tick();
    assert.ok(old.destroyed, 'the old entity is gone');
    assert.ok(oldAsset.unloaded, 'and so is its asset');
    assert.equal(entry.row.sog_sha256, 'b'.repeat(64), 'the entry carries the new row');
    assert.match(entry.asset.file.url, /\/tiles\/10\/535\/361\/b{64}\.sog$/);
    assert.equal(s.tiles.get('10/535/361').published_version, 2,
        'and the traversal sees the new version');
});

test('polling does nothing without a fetcher', async () => {
    const rows = COORDS.map((c) => row(...c));
    assert.equal(await streamerWith(rows, null).poll(), 0);
    const s = streamerWith(rows, async () => rows);
    assert.equal(await s.poll(), 0, 'nothing loaded, nothing to swap');
});

test('a tile published while the page is open reaches the traversal', async () => {
    const rows = COORDS.map((c) => row(...c));
    const fresh = { ...row(12, 2140, 1444), published_version: 1, sog_sha256: 'c'.repeat(64) };
    const asked = [];
    const s = streamerWith(rows, async (loaded, since) => {
        asked.push({ loaded, since });
        return [fresh];
    });
    assert.equal(await s.poll(), 0, 'nothing loaded is swapped');
    assert.equal(asked[0].loaded.length, 0);
    assert.match(asked[0].since, /^\d{4}-\d{2}-\d{2}T/, 'asked since the page opened');
    assert.equal(s.tiles.get('12/2140/1444').published_version, 1,
        'the new tile is what its parent refines into next');
});

test('a failed load backs off instead of retrying every frame', () => {
    const rows = COORDS.map((c) => row(...c));
    const s = streamerWith(rows, null, { fail: () => true });
    const before = Date.now();
    assert.equal(s.update(camera(2e7)).load.length, 1, 'the root is tried');
    assert.equal(s.entries.size, 0);
    assert.equal(s.pending, 0, 'the in-flight count fell back');
    assert.ok(s.failed.get('6/33/22') >= before + RETRY_MS, 'and marked for a later retry');
    assert.equal(s.update(camera(2e7)).load.length, 0, 'the next frame leaves it alone');
    s.failed.set('6/33/22', Date.now() - 1);
    assert.equal(s.update(camera(2e7)).load.length, 1, 'until the backoff is over');
});

test('a load that finishes after its tile was unloaded is unloaded again', async () => {
    const rows = COORDS.map((c) => row(...c));
    const s = streamerWith(rows, null, { manual: true });
    const released = [];
    s.onRelease = (k) => released.push(k);
    s.update(camera(2e7));
    const [asset] = s.app.loads;
    assert.equal(s.pending, 1);
    s.unload('6/33/22');
    assert.deepEqual(released, ['6/33/22']);
    assert.equal(s.pending, 0);
    s.app.fire(asset);
    await tick();
    assert.equal(asset.unloads, 2, 'the resource that arrived for nobody is dropped');
    assert.equal(s.entries.size, 0);
});

test('arrivals are placed one per update, and count as in flight until then', () => {
    const rows = COORDS.map((c) => row(...c));
    const s = streamerWith(rows, null);
    const cam = camera(1e6);
    s.update(cam);                              // claims four; the fake loads at once
    const placed = () => [...s.entries.values()].filter((e) => e.entity).length;
    assert.equal(s.pending, 4, 'arrived but not yet placed is still in flight');
    assert.equal(placed(), 0);
    s.update(cam);
    assert.equal(placed(), 1);
    assert.equal(s.pending, 3);
    for (let i = 0; i < 3; i++) s.update(cam);
    assert.equal(s.pending, 0);
    assert.equal(placed(), 4);
    assert.equal(s.placeNext(), null, 'nothing left to place');
});

test('an arrival unloaded before its frame is never placed', async () => {
    const rows = COORDS.map((c) => row(...c));
    const s = streamerWith(rows, null);
    s.update(camera(2e7));                      // the root arrives, unplaced
    assert.equal(s.arrived.length, 1);
    s.unload('6/33/22');
    assert.equal(s.pending, 0);
    assert.equal(s.placeNext(), null);
    await tick();
    assert.equal(s.entries.size, 0);
});

test('of two swaps in flight, only the newest is adopted', async () => {
    const rows = COORDS.map((c) => row(...c));
    const s = streamerWith(rows, null, { manual: true });
    const released = [];
    s.onRelease = (k) => released.push(k);
    const old = { destroy() { this.destroyed = true; } };
    const entry = { row: rows[0], entity: old, asset: null, usedAt: 1 };
    s.entries.set('10/535/361', entry);
    s.swap('10/535/361', swapRow(rows[0], 'b'.repeat(64)));
    s.swap('10/535/361', swapRow(rows[0], 'c'.repeat(64)));
    const [b, c] = s.app.loads;
    assert.equal(s.app.loads.length, 2);
    s.app.fire(b);
    await tick();
    assert.equal(s.swaps, 0, 'the older arrival is not adopted');
    assert.ok(b.unloaded, 'and its resource is dropped');
    assert.equal(entry.entity, old);
    s.app.fire(c);
    assert.equal(s.swaps, 1);
    assert.equal(entry.row.sog_sha256, 'c'.repeat(64));
    await tick();
    assert.ok(old.destroyed);
    assert.deepEqual(released, ['10/535/361'], 'the ground under the old version is let go');
    // Late again, after the entry has settled: still dropped.
    s.swap('10/535/361', swapRow(rows[0], 'd'.repeat(64)));
    s.swap('10/535/361', swapRow(rows[0], 'c'.repeat(64)));
    s.app.fire(s.app.loads[2]);
    assert.equal(s.swaps, 1, 'a version older than the one asked for last is dropped');
});
