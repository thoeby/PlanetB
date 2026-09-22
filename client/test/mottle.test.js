// The ground's colour is mottled from point to point (assemble-v12,
// client/lib/terrain.js mottleAt): a hillside of one colour gives a trainer
// nothing to hold a splat in place with. A mottle, not a pattern: bounded,
// and the one field across a tile's edge into its neighbour.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Terrain, mottleAt, terrainMesh } from '../lib/terrain.js';

const flat = (size = 33) => new Terrain({ sw: { x: -100, z: 100 }, ne: { x: 100, z: -100 },
    size, dem: null });

test('the mottle stays within a seventh of the colour either way', () => {
    const t = flat();
    let lo = Infinity; let hi = -Infinity;
    for (let j = 0; j < t.size; j++) {
        for (let i = 0; i < t.size; i++) {
            const m = mottleAt(t, i, j, { z: 16, x: 3, y: 4 });
            lo = Math.min(lo, m); hi = Math.max(hi, m);
        }
    }
    assert.ok(lo >= 1 - 0.14 - 1e-9 && hi <= 1 + 0.14 + 1e-9, `${lo}..${hi}`);
    assert.ok(hi - lo > 0.1, 'and it is not nothing');
});

test('neighbouring tiles carry the one field across their shared edge', () => {
    const t = flat();
    const n = t.size;
    for (let j = 0; j < n; j += 4) {
        assert.equal(mottleAt(t, n - 1, j, { z: 16, x: 3, y: 4 }),
            mottleAt(t, 0, j, { z: 16, x: 4, y: 4 }), 'east edge meets west edge');
        assert.equal(mottleAt(t, j, n - 1, { z: 16, x: 3, y: 4 }),
            mottleAt(t, j, 0, { z: 16, x: 3, y: 5 }), 'south edge meets north edge');
    }
});

test('terrainMesh lays it over the colour only when asked', () => {
    const t = flat(9);
    const plain = terrainMesh(t, 'terrain', () => [0.2, 0.4, 0.2]);
    const mottled = terrainMesh(t, 'terrain', () => [0.2, 0.4, 0.2], null,
        { tile: { z: 16, x: 1, y: 1 }, mottle: true });
    assert.ok(plain.colors.every((c, k) => c === [0.2, 0.4, 0.2][k % 3]));
    assert.ok(mottled.colors.some((c, k) => c !== [0.2, 0.4, 0.2][k % 3]));
    for (let k = 0; k < mottled.colors.length; k++) {
        const base = [0.2, 0.4, 0.2][k % 3];
        assert.ok(Math.abs(mottled.colors[k] / base - 1) <= 0.14 + 1e-9);
    }
});
