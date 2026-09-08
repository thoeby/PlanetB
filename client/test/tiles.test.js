// tiles.test.js — flies a scripted path over the WP1.2 test region and asserts
// what is loaded at five checkpoints. The traversal in client/js/tiles.js is a
// pure function of (published tiles, camera, what is loaded), so the whole
// policy — refinement, hysteresis, culling, the caps, LRU eviction — is
// exercised here without a GPU. The browser leg is client/test/e2e.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as tm from '../lib/tilemath.js';
import { FloatingOrigin } from '../js/origin.js';
import {
    selectTiles, key, LIMITS, POLL_MS, sphereVisible, tileRadius, TileStreamer,
} from '../js/tiles.js';

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

function world(extra = []) {
    const rows = [...COORDS.map((c) => row(...c)), ...extra];
    return {
        tiles: new Map(rows.map((r) => [key(r.z, r.x, r.y), r])),
        roots: rows.filter((r) => r.z === tm.MIN_ZOOM && r.published_version > 0),
        origin: new FloatingOrigin(tm.tileFrame(10, 535, 361, 0)),
        loaded: new Map(),
        inflight: 0,
    };
}

const camera = (y, planes = null) => ({
    position: { x: 0, y, z: 0 }, planes, screenH: 1080, fovY: 45 * tm.RAD_PER_DEG,
});

const sorted = (set) => [...set].sort();

// Applies a selection: what was told to load is loaded, what was told to go goes.
function step(w, cam) {
    const sel = selectTiles(w, cam);
    for (const k of sel.unload) w.loaded.delete(k);
    for (const c of sel.load) w.loaded.set(c.key, { usedAt: w.loaded.size + 1 });
    return sel;
}

// Runs a camera to a settled state: the streamer loads at most four tiles per
// pass, so a big jump takes a few.
function settle(w, cam, passes = 12) {
    let sel;
    for (let i = 0; i < passes; i++) sel = step(w, cam);
    return sel;
}

test('the scripted flight loads the right tiles at five checkpoints', () => {
    const w = world();
    const seen = [];
    for (const alt of [2e7, 5e6, 1e6, 2e3, 2e7]) {
        settle(w, camera(alt));
        seen.push(sorted(w.loaded.keys()));
    }
    assert.deepEqual(seen[0], ['6/33/22'], 'from 20 000 km, one z6 tile');
    assert.deepEqual(seen[1], ['8/133/90', '8/134/90'], 'at 5 000 km, both z8 parents');
    assert.deepEqual(seen[2],
        ['10/535/361', '10/535/362', '10/536/361', '10/536/362'],
        'at 1 000 km, the four z10 children');
    assert.deepEqual(seen[3], seen[2], 'at 2 km, still the four z10: they are the leaves');
    assert.deepEqual(seen[4], ['6/33/22'], 'back at 20 000 km, coarse again and the rest gone');
});

test('no entity is placed further than 1e5 m from the floating origin', () => {
    const w = world();
    let worst = 0;
    for (const alt of [2e7, 5e6, 1e6, 2e3, 2e7]) {
        settle(w, camera(alt));
        for (const k of w.loaded.keys()) {
            const p = w.origin.localOf(w.tiles.get(k).manifest.origin);
            worst = Math.max(worst, Math.hypot(p.x, p.y, p.z));
        }
    }
    assert.ok(worst < 1e5, `worst entity offset ${worst.toFixed(0)} m`);
});

test('a tile does not refine into a level with an unpublished hole', () => {
    // Take one z10 away and its z8 parent must stay whole rather than show a gap.
    const holed = world();
    holed.tiles.set('10/535/362', row(10, 535, 362, false));
    settle(holed, camera(1e6));
    assert.deepEqual(sorted(holed.loaded.keys()), ['10/536/361', '10/536/362', '8/133/90'],
        'the parent of the hole stays coarse, its sibling refines');
});

test('children that do not exist are not holes', () => {
    // 8/133/90 has 16 possible children and only two rows: the other fourteen
    // lie outside any compiled area, which is not the same as unpublished.
    const w = world();
    settle(w, camera(1e6));
    assert.ok(w.loaded.has('10/535/361'), 'refined despite fourteen absent children');
});

test('hysteresis keeps a refined level from flapping', () => {
    const w = world();
    settle(w, camera(1e6));
    const refined = sorted(w.loaded.keys());
    // Just inside the coarsening threshold: refining here would not have
    // happened, but what is already refined stays.
    settle(w, camera(2.6e6));
    assert.deepEqual(sorted(w.loaded.keys()), refined, 'still refined on the way out');
    settle(w, camera(4e6));
    assert.deepEqual(sorted(w.loaded.keys()), ['8/133/90', '8/134/90'],
        'and coarsens once the error is comfortably under two pixels');
});

test('at most four tiles are started per pass', () => {
    const w = world();
    const first = selectTiles(w, camera(1e6));
    assert.ok(first.load.length <= LIMITS.inflight, `${first.load.length} started`);
    w.inflight = LIMITS.inflight;
    assert.equal(selectTiles(w, camera(1e6)).load.length, 0, 'nothing while four are in flight');
});

test('the caps bound the loaded set and evict the least recently used', () => {
    const w = world();
    settle(w, camera(1e6));
    const tight = selectTiles(w, camera(1e6), { tiles: 2, splats: 25e6, inflight: 4 });
    assert.equal(tight.want.size, 2, 'the tile cap holds');
    assert.ok(tight.want.has('10/535/361'), 'and keeps the tile under the camera');
    assert.equal(tight.unload.length, 2, 'the other two are evicted');

    const budget = selectTiles(w, camera(1e6),
        { tiles: 40, splats: GRID[10] ** 2 * 3, inflight: 4 });
    assert.equal(budget.want.size, 3, 'the splat budget holds too');
    assert.ok(budget.splats <= GRID[10] ** 2 * 3, `${budget.splats} splats`);
});

test('frustum culling drops tiles behind the camera', () => {
    const c = { x: 0, y: 0, z: 0 };
    const behind = [[0, 0, -1, 0]];             // inward normal points to -Z
    assert.equal(sphereVisible({ x: 0, y: 0, z: 1000 }, 10, behind), false);
    assert.equal(sphereVisible({ x: 0, y: 0, z: -1000 }, 10, behind), true);
    assert.equal(sphereVisible({ x: 0, y: 0, z: 5 }, 10, behind), true, 'straddling counts');
    assert.equal(sphereVisible(c, 1, null), true, 'no planes, no culling');

    const w = world();
    settle(w, camera(1e6));
    const loaded = sorted(w.loaded.keys());
    // A half-space through the anchor: the eastern column sits 27 km away with
    // a 21 km radius, so it falls entirely outside.
    settle(w, { ...camera(1e6), planes: [[-1, 0, 0, 0]] });
    assert.ok(w.loaded.size < loaded.length, 'the eastern tiles were culled');
    assert.deepEqual(sorted(w.loaded.keys()), ['10/535/361', '10/535/362'],
        'the western ones stayed');
});

test('tileRadius covers the tile it bounds', () => {
    for (const [z, x, y] of COORDS) {
        const b = tm.tileBbox(z, x, y);
        const o = tm.tileFrame(z, x, y, 0);
        const corner = tm.localFromLonLat(o, b.east, b.north);
        assert.ok(tileRadius(z, x, y) >= Math.hypot(corner.x, corner.z),
            `${z}/${x}/${y} radius is short`);
    }
});


// ------------------------------------------------------------------ hot swap
//
// Enough of PlayCanvas to watch the streamer's bookkeeping: loading an asset
// runs its ready callbacks straight away, so a swap completes within the call.

function fakePc() {
    return {
        Asset: class {
            constructor(name, type, file) {
                Object.assign(this, { name, type, file, ready_: [] });
            }
            ready(fn) { this.ready_.push(fn); }
            once() { /* errors are not exercised here */ }
            unload() { this.unloaded = true; }
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

const fakeApp = () => ({
    root: { addChild() {} },
    assets: { add() {}, remove() {}, load: (a) => a.ready_.forEach((fn) => fn()) },
});

function streamerWith(rows, fetchRows) {
    const w = world();
    const s = new TileStreamer(fakeApp(), fakePc(), {
        origin: w.origin, filesUrl: 'http://files', fetchRows,
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
    assert.ok(old.destroyed, 'the old entity is gone');
    assert.ok(oldAsset.unloaded, 'and so is its asset');
    assert.equal(entry.row.sog_sha256, 'b'.repeat(64), 'the entry carries the new row');
    assert.match(entry.asset.file.url, /\/tiles\/10\/535\/361\/b{64}\.sog$/);
    assert.equal(s.tiles.get('10/535/361').published_version, 2,
        'and the traversal sees the new version');
});

test('polling does nothing without a fetcher or without tiles', async () => {
    const rows = COORDS.map((c) => row(...c));
    assert.equal(await streamerWith(rows, null).poll(), 0);
    const s = streamerWith(rows, async () => rows);
    assert.equal(await s.poll(), 0, 'nothing loaded, nothing to check');
});
