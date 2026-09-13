// WP4.2 — the parts of build mode that are arithmetic: where a click lands on
// the terrain, what a gizmo step does to a row, and what the undo stack owes.
//
// The rest of build mode is the API and the engine, and that is what
// client/test/e2e/build.spec.js drives.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Edits, SNAP, raycastGround, snapTo } from '../js/build.js';
import { patchFor } from '../js/buildui.js';
import { basisOf, placeMeshes } from '../lib/glbmesh.js';
import { FloatingOrigin } from '../js/origin.js';
import { canonicalise } from '../lib/canon.js';
import { FIXTURES, checker } from '../../tools/make-asset-fixtures.mjs';

// A hill, so the ray has something to miss and then hit.
const hill = {
    heightAt: ({ x, z }) => (Math.hypot(x, z) > 200 ? null : 10 * Math.cos(x / 40)),
};

test('a ray from above lands on the ground it points at', () => {
    const hit = raycastGround(hill, { x: 0, y: 60, z: 0 }, { x: 0, y: -1, z: 0 });
    assert.ok(hit, 'the ray hit nothing');
    assert.ok(Math.abs(hit.y - hill.heightAt(hit)) < 1e-3, 'the hit is on the surface');
    assert.ok(Math.abs(hit.x) < 1e-6 && Math.abs(hit.z) < 1e-6, 'straight down stays put');
});

test('a slanted ray lands where the ground rises to meet it', () => {
    const dir = { x: 0.6, y: -0.8, z: 0 };
    const hit = raycastGround(hill, { x: -60, y: 40, z: 0 }, dir);
    assert.ok(hit);
    assert.ok(hit.x > -60, 'it travelled east');
    assert.ok(Math.abs(hit.y - hill.heightAt(hit)) < 1e-3);
});

test('a ray that never meets the ground hits nothing', () => {
    assert.equal(raycastGround(hill, { x: 0, y: 60, z: 0 }, { x: 0, y: 1, z: 0 }), null);
    assert.equal(raycastGround(hill, { x: 900, y: 60, z: 0 }, { x: 0, y: -1, z: 0 }), null,
        'off the heightfield is not a hit');
});

test('a ray that starts underground is not a hit', () => {
    assert.equal(raycastGround(hill, { x: 0, y: -50, z: 0 }, { x: 0, y: -1, z: 0 }), null);
});

// ------------------------------------------------------------------- gizmo

test('snapping is to the grid, and off is off', () => {
    assert.equal(snapTo(0.31, SNAP.move), 0.25);
    assert.equal(snapTo(0.4, SNAP.move), 0.5);
    assert.equal(snapTo(0.31, 0), 0.31);
});

const origin = new FloatingOrigin({ lon: 8.04, lat: 47.39, h: 400 });
const row = { lon: 8.04, lat: 47.39, h: 400, yaw: 0, pitch: 0, roll: 0, scale: 1 };

test('a move step is a metre on the ground, stored as a position', () => {
    const patch = patchFor(origin, row, 'move', 'x', 1);
    const before = origin.localOf(row);
    const after = origin.localOf(patch);
    assert.ok(Math.abs(after.x - before.x - 1) < 1e-6, 'one metre east');
    assert.ok(Math.abs(after.z - before.z) < 1e-6, 'and nowhere else');
    assert.notEqual(patch.lon, row.lon, 'the row moved in degrees, not metres');
});

test('a turn step snaps to fifteen degrees on the axis it is given', () => {
    assert.equal(patchFor(origin, row, 'turn', 'y', SNAP.turn).yaw, SNAP.turn);
    assert.equal(patchFor(origin, row, 'turn', 'x', SNAP.turn).pitch, SNAP.turn);
    assert.equal(patchFor(origin, row, 'turn', 'z', -SNAP.turn).roll, -SNAP.turn);
});

test('a size step snaps, and never reaches zero', () => {
    assert.equal(patchFor(origin, row, 'size', 'x', 0.1).scale, 1.1);
    assert.equal(patchFor(origin, { ...row, scale: 0.1 }, 'size', 'x', -1).scale, 0.05);
});

// --------------------------------------------------------------------- undo

// A fake API: the Edits stack is about ordering and inverses, not HTTP.
function fakeApi() {
    const rows = new Map();
    let next = 1;
    return {
        rows,
        insert: (_t, made) => made.map((row) => {
            const id = `i${next++}`;
            rows.set(id, { id, ...row });
            return rows.get(id);
        }),
        update: (_t, params, patch) => {
            const id = params.id.slice(3);
            rows.set(id, { ...rows.get(id), ...patch });
            return [rows.get(id)];
        },
        remove: (_t, params) => { rows.delete(params.id.slice(3)); },
    };
}

// SPEC §0.3: an object being positioned is `placing` — not saved, and only
// this tab sees it. Nothing reaches the world until Save.
test('nothing is written until it is saved', async () => {
    await (async (fake) => {
        const edits = new Edits({ writes: fake });
        edits.place('area', 'SBENCH0000000', { lon: 1, lat: 2, h: 3 });
        edits.place('area', 'SBENCH0000000', { lon: 1.1, lat: 2, h: 3 });
        assert.equal(fake.rows.size, 0, 'two placed, none written');
        assert.equal(edits.unsaved, 2);

        const done = await edits.save();
        assert.equal(done.objects, 2);
        assert.equal(fake.rows.size, 2, 'and now they are the world\'s');
        assert.equal(edits.unsaved, 0);
    })(fakeApi());
});

test('undo puts back what the last edit changed, and not more', async () => {
    await (async (fake) => {
        const edits = new Edits({ writes: fake });
        const placed = edits.place('area', 'SBENCH0000000', { lon: 1, lat: 2, h: 3 });
        const turned = await edits.transform(placed, { yaw: 0.5 });
        assert.equal(turned.yaw, 0.5);
        assert.equal(edits.depth, 2);

        const back = await edits.undo();
        assert.equal(back.yaw, 0, 'the turn was undone');
        assert.equal(edits.unsaved, 1, 'and the object is still being placed');
        assert.equal(edits.depth, 1);

        assert.equal(await edits.undo(), null, 'undoing a placement removes it');
        assert.equal(edits.unsaved, 0);
        assert.equal(edits.depth, 0);
        assert.equal(await edits.undo(), null, 'an empty stack undoes nothing');
    })(fakeApi());
});

test('undoing after a save takes the row away', async () => {
    await (async (fake) => {
        const edits = new Edits({ writes: fake });
        edits.place('area', 'SBENCH0000000', { lon: 1, lat: 2, h: 3 });
        await edits.save();
        assert.equal(fake.rows.size, 1);
        await edits.undo();
        assert.equal(fake.rows.size, 0, 'what was saved is taken back out');
    })(fakeApi());
});

test('undoing a delete puts the instance back', async () => {
    await (async (fake) => {
        const edits = new Edits({ writes: fake });
        edits.place('area', 'SBENCH0000000', { lon: 1, lat: 2, h: 3 });
        const [placed] = (await edits.save()).rows;
        await edits.remove(placed);
        assert.equal(fake.rows.size, 0);
        const back = await edits.undo();
        assert.equal(fake.rows.size, 1);
        assert.equal(back.san, 'SBENCH0000000');
    })(fakeApi());
});

// ------------------------------------------------------------------ placing

// Only a canonical GLB may be placed: an instance names asset.sha256, which is
// what canon-v1 produced, and glbmesh.js refuses anything else.
test('a placed asset is the asset, moved, turned and scaled', async () => {
    const { glb } = await canonicalise(FIXTURES.blender(checker(8)));
    const at = [100, 20, -50];
    const plain = placeMeshes(glb, { at });
    const turned = placeMeshes(glb, { at, yaw: Math.PI / 2, scale: 2 });

    const box = (meshes) => {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (const m of meshes) {
            for (let i = 0; i < m.positions.length; i += 3) {
                for (let c = 0; c < 3; c++) {
                    min[c] = Math.min(min[c], m.positions[i + c]);
                    max[c] = Math.max(max[c], m.positions[i + c]);
                }
            }
        }
        return { min, max };
    };

    // The bench is 1.8 x 0.5 x 0.5 m and canon-v1 stands it on y = 0.
    const a = box(plain);
    assert.ok(Math.abs(a.min[1] - at[1]) < 1e-4, 'it stands on the point it was placed at');
    assert.ok(Math.abs((a.max[0] - a.min[0]) - 1.8) < 1e-3);
    assert.ok(Math.abs((a.max[2] - a.min[2]) - 0.5) < 1e-3);

    const b = box(turned);
    assert.ok(Math.abs((b.max[0] - b.min[0]) - 1.0) < 1e-3, 'a quarter turn swaps the sides');
    assert.ok(Math.abs((b.max[2] - b.min[2]) - 3.6) < 1e-3, 'and twice the size doubles them');
});

test('a raw export is refused rather than laid on its side', () => {
    assert.throws(() => placeMeshes(FIXTURES.blender(checker(8)), { at: [0, 0, 0] }),
        /canonical GLB is expected/);
});

test('a basis with no rotation is the scale, and rotations are orthonormal', () => {
    assert.deepEqual(basisOf(0, 0, 0, 2), [2, 0, 0, 0, 2, 0, 0, 0, 2]);
    const m = basisOf(0.4, -0.2, 1.1, 1);
    for (let r = 0; r < 3; r++) {
        const len = Math.hypot(m[r * 3], m[r * 3 + 1], m[r * 3 + 2]);
        assert.ok(Math.abs(len - 1) < 1e-9, `row ${r} is not a unit vector`);
    }
});
