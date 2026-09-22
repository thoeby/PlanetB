// db/0186 — a third of the seed is a lattice across the ground. The allocation
// (client/lib/sampling.js allocate) is fair by area and a lottery by triangle:
// tiles kept coming back with stretches of hillside tens of metres across
// that had no splat on them at all, and a trainer cannot move what is not
// there. gridSurfaces puts one splat at every point of a square lattice that
// falls on the ground, whatever the allocation does around it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { rng } from '../lib/poly.js';
import { SEED, gridSurfaces, seedOf, seedSurfaces } from '../lib/sampling.js';

const SIDE = 120;

// A square of ground as a 4 x 4 heightfield of quads, a ridge down the middle
// and one colour per row, so a lattice point takes a real height and colour.
function ground() {
    const n = 5;
    const positions = []; const normals = []; const colors = []; const indices = [];
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            positions.push(i * SIDE / (n - 1), 10 - Math.abs(i - 2) * 5, j * SIDE / (n - 1));
            normals.push(0, 1, 0);
            colors.push(0.2, 0.2 + j * 0.1, 0.2);
        }
    }
    for (let j = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
            const a = j * n + i;
            indices.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
        }
    }
    return { material: 'terrain', positions: new Float32Array(positions),
        normals: new Float32Array(normals), colors: new Float32Array(colors),
        indices: new Uint32Array(indices) };
}

const roof = () => ({
    material: 'roof',
    positions: new Float32Array([10, 20, 10, 30, 20, 10, 10, 20, 30]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
});

// The widest gap between a point of the ground and its nearest splat, over a
// fine probe of the square: the hole a lattice is there to rule out.
function widestHole(f) {
    let worst = 0;
    for (let pz = 1; pz < SIDE; pz += 2) {
        for (let px = 1; px < SIDE; px += 2) {
            let near = Infinity;
            for (let k = 0; k < f.count; k++) {
                near = Math.min(near, (f.x[k] - px) ** 2 + (f.z[k] - pz) ** 2);
            }
            worst = Math.max(worst, near);
        }
    }
    return Math.sqrt(worst);
}

test('a lattice covers the ground: no point of it is more than a spacing from a splat', () => {
    const n = 400;
    const f = gridSurfaces([ground()], n);
    const spacing = Math.sqrt(SIDE * SIDE / n);
    assert.ok(Math.abs(f.count - n) < n * 0.1, `about ${n} splats: ${f.count}`);
    assert.ok(widestHole(f) < spacing, `widest hole ${widestHole(f)} m at ${spacing} m spacing`);
    for (let k = 0; k < f.count; k++) {
        assert.ok(f.y[k] >= 0 && f.y[k] <= 10, 'every splat sits on the ridge, at its height');
        assert.ok(f.sx[k] === spacing * SEED.spread && f.sy[k] < f.sx[k],
            'a disc half a spacing in sigma, flat on the ground');
    }
    // The colour is the ground's own, row by row: green rises with z.
    const north = [...Array(f.count).keys()].filter((k) => f.z[k] < 20).map((k) => f.g[k]);
    const south = [...Array(f.count).keys()].filter((k) => f.z[k] > 100).map((k) => f.g[k]);
    assert.ok(Math.min(...south) > Math.max(...north), 'each splat takes its triangle\'s colour');
});

test('the same ground is the same lattice, and a lattice point is placed once', () => {
    const a = gridSurfaces([ground()], 300);
    const b = gridSurfaces([ground()], 300);
    assert.deepEqual([...a.x], [...b.x]);
    const seen = new Set();
    for (let k = 0; k < a.count; k++) seen.add(`${a.x[k]},${a.z[k]}`);
    assert.equal(seen.size, a.count, 'no two splats share a lattice point');
});

test('the seed spends the grid share on the lattice and the rest as before', () => {
    const meshes = [ground(), roof()];
    const total = 3000;
    const grid = 1 / 3;
    const f = seedSurfaces(meshes, total, rng(7), { spread: 0.5, even: true, floor: 0.66, grid });
    assert.equal(f.count, total, 'the whole seed is spent, lattice included');
    const lattice = gridSurfaces([ground()], Math.round(total * grid));
    assert.deepEqual([...f.x.slice(0, lattice.count)], [...lattice.x],
        'the lattice is the seed\'s prefix');
    let onRoof = 0;
    for (let k = 0; k < f.count; k++) if (f.y[k] === 20) onRoof++;
    assert.ok(onRoof > 0 && onRoof < total * 0.34,
        `what stands on the ground still gets its share of what is left: ${onRoof}`);
});

test('a hole in the ground is a hole in the lattice', () => {
    const g = ground();
    // Drop the middle four quads: eight triangles from index 6*5 on.
    const keep = [];
    for (let t = 0; t < g.indices.length / 3; t++) {
        const quad = Math.floor(t / 2);
        const [qi, qj] = [quad % 4, Math.floor(quad / 4)];
        if (qi >= 1 && qi <= 2 && qj >= 1 && qj <= 2) continue;
        keep.push(...g.indices.subarray(t * 3, t * 3 + 3));
    }
    const f = gridSurfaces([{ ...g, indices: new Uint32Array(keep) }], 400);
    for (let k = 0; k < f.count; k++) {
        assert.ok(!(f.x[k] > 30 && f.x[k] < 90 && f.z[k] > 30 && f.z[k] < 90),
            'nothing is placed over the opening');
    }
});

test('seedOf is one recipe: the atom\'s params where it has them, SEED where not', () => {
    const meshes = [ground(), roof()];
    const own = seedOf(meshes, 10_000, rng(1));
    assert.equal(own.count, undefined);
    assert.equal(own.seed.count, 3000, 'three tenths of the budget');
    assert.deepEqual([own.share, own.grid, own.floor], [SEED.share, SEED.grid, SEED.floor]);
    const asked = seedOf(meshes, 10_000, rng(1),
        { seed_share: 0.5, seed_grid: 0, ground_floor: 0 });
    assert.equal(asked.seed.count, 5000);
    assert.deepEqual([asked.share, asked.grid, asked.floor], [0.5, 0, 0]);
    const same = seedOf(meshes, 10_000, rng(1));
    assert.deepEqual([...own.seed.x], [...same.seed.x], 'the same seed is the same seed');
});
