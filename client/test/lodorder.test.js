// The order that makes a prefix a level (client/lib/lodorder.js): that it is a
// permutation, that the levels nest, that the ranking is the geometry's and not
// the input order's — and, the one that matters, that a coarse prefix actually
// covers the ground where a shuffled one does not.

import test from 'node:test';
import assert from 'node:assert/strict';

import { LEVELS, MAX_LEVELS, MIN_LEVEL, lodLevelCounts, lodOrder } from '../lib/lodorder.js';
import { emptySplats, permute } from '../lib/ply.js';
import { shuffled } from '../lib/preview.js';
import { rng } from '../lib/poly.js';

// n splats on a jittered grid over `span` metres square, all the same size.
function sheet(n, span = 100, seed = 3, size = 0.4) {
    const random = rng(seed);
    const f = emptySplats(n);
    const side = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++) {
        const gx = i % side, gy = Math.floor(i / side);
        f.x[i] = ((gx + random()) / side - 0.5) * span;
        f.z[i] = ((gy + random()) / side - 0.5) * span;
        f.y[i] = 0;
        f.a[i] = 1;
        f.sx[i] = size; f.sy[i] = size * 0.1; f.sz[i] = size;
        f.qw[i] = 1;
    }
    return f;
}

const at = (f, i) => `${f.x[i].toFixed(4)},${f.y[i].toFixed(4)},${f.z[i].toFixed(4)}`;

test('the order is a permutation of the splats, nothing lost or repeated', () => {
    const f = sheet(5000);
    const { order } = lodOrder(f);
    assert.equal(order.length, f.count);
    assert.deepEqual([...order].sort((a, b) => a - b), [...Array(f.count).keys()]);
});

test('the levels nest, finest first, and stop before they are meaningless', () => {
    const { levels } = lodOrder(sheet(20000));
    assert.equal(levels[0].count, 20000, 'level 0 is the whole tile (the engine sums it)');
    assert.ok(levels.length > 1, 'and there is a ladder under it');
    assert.ok(levels.length <= MAX_LEVELS);
    for (let i = 1; i < levels.length; i++) {
        assert.ok(levels[i].count < levels[i - 1].count, `level ${i} is coarser`);
        assert.ok(levels[i].count >= MIN_LEVEL, 'and still enough splats to be a picture');
        assert.ok(levels[i].cell > 0, 'and says how far its splats have to reach');
    }
});

test('a coarser level is a literal prefix of every finer one', () => {
    // This is the property the engine's `offset 0, count n` maths rests on.
    const f = sheet(20000);
    const { order, levels } = lodOrder(f);
    for (let i = 1; i < levels.length; i++) {
        const coarse = [...order.slice(0, levels[i].count)];
        const finer = [...order.slice(0, levels[i - 1].count)].slice(0, levels[i].count);
        assert.deepEqual(coarse, finer);
    }
});

test('the ranking is the geometry, not the order the splats arrived in', () => {
    // Invariant 7 in the form that matters: two tabs holding the same splats
    // in different orders must choose the same splats for each level.
    const f = sheet(4000);
    const a = lodOrder(f);
    const g = shuffled(f, rng(11));
    const b = lodOrder(g);
    assert.deepEqual(a.levels, b.levels);
    for (const { count } of a.levels) {
        const one = [...a.order.slice(0, count)].map((i) => at(f, i)).sort();
        const two = [...b.order.slice(0, count)].map((i) => at(g, i)).sort();
        assert.deepEqual(one, two, `the same ${count} splats either way`);
    }
});

test('the same splats give the same order twice', () => {
    const f = sheet(3000);
    assert.deepEqual([...lodOrder(f).order], [...lodOrder(f).order]);
});

test('a coarse prefix covers the tile, where a shuffled one leaves holes', () => {
    // The whole reason this library exists rather than a call to shuffled().
    const SPAN = 100;
    const f = sheet(10000, SPAN);
    const { order, levels } = lodOrder(f);
    const n = levels[levels.length - 1].count;

    // How far a lattice of query points is from the nearest splat of a prefix,
    // squared, so nothing transcendental decides the answer.
    const worst = (take) => {
        let far = 0;
        for (let qi = 0; qi < 16; qi++) {
            for (let qj = 0; qj < 16; qj++) {
                const qx = ((qi + 0.5) / 16 - 0.5) * SPAN;
                const qz = ((qj + 0.5) / 16 - 0.5) * SPAN;
                let near = Infinity;
                for (const i of take) {
                    const dx = f.x[i] - qx, dz = f.z[i] - qz;
                    const d = dx * dx + dz * dz;
                    if (d < near) near = d;
                }
                far = Math.max(far, near);
            }
        }
        return far;
    };

    const ideal = SPAN / Math.sqrt(n);
    const bound = (2 * ideal) ** 2;
    const ours = worst([...order.slice(0, n)]);
    assert.ok(ours <= bound,
        `the coarse level leaves a gap of ${Math.sqrt(ours).toFixed(1)} m, over ${
            Math.sqrt(bound).toFixed(1)} m`);

    const random = rng(5);
    const bag = [...Array(f.count).keys()];
    for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    assert.ok(worst(bag.slice(0, n)) > ours,
        'and a shuffled prefix of the same length leaves a bigger one');
});

test('the widest splat in a cell is the one that speaks for it', () => {
    const f = emptySplats(2);
    f.x.set([-40, 40]); f.z.set([0, 0]); f.a.fill(1); f.qw.fill(1);
    f.sy.fill(0.1);
    f.sx.set([1, 5]); f.sz.set([1, 5]);            // the second is far wider
    const { order } = lodOrder(f);
    assert.equal(order[0], 1, 'the wider one comes first');

    const g = emptySplats(2);
    g.x.set([-40, 40]); g.z.set([0, 0]); g.a.fill(1); g.qw.fill(1);
    g.sy.fill(0.1); g.sx.fill(2); g.sz.fill(2);    // now they are equal
    assert.equal(lodOrder(g).order[0], 0, 'and on a tie, the earlier index');
});

test('a tile that is degenerate is still a permutation', () => {
    for (const f of [emptySplats(0), emptySplats(1)]) {
        const { order, levels } = lodOrder(f);
        assert.equal(order.length, f.count);
        assert.deepEqual(levels, [{ count: f.count, cell: 0 }]);
    }
    const flat = emptySplats(8);                    // every splat in one place
    flat.a.fill(1); flat.qw.fill(1); flat.sx.fill(1); flat.sz.fill(1);
    const { order } = lodOrder(flat);
    assert.deepEqual([...order].sort((a, b) => a - b), [...Array(8).keys()]);

    const bad = sheet(64);                          // one coordinate is not a number
    bad.x[7] = NaN;
    const out = lodOrder(bad);
    assert.deepEqual([...out.order].sort((a, b) => a - b), [...Array(64).keys()]);
    assert.ok(out.order.every(Number.isInteger), 'and no key came out NaN');
});

test('permute moves every field and nothing else', () => {
    const f = sheet(10);
    const order = Uint32Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const out = permute(f, order);
    assert.equal(out.count, 10);
    for (let i = 0; i < 10; i++) assert.equal(out.x[i], f.x[9 - i]);
    assert.deepEqual([...permute(f, Uint32Array.from([...Array(10).keys()])).x], [...f.x]);
});

test('the ladder is the grids that earned a place', () => {
    // A tile whose cells fill up slowly gets fewer levels, not three nominal
    // ones: a boundary is taken only if it is a quarter of the last.
    assert.deepEqual(lodLevelCounts([300, 320, 340, 360], 400), [{ count: 400, cell: 0 }]);
    const even = [];
    for (let l = 0; l < LEVELS; l++) even.push(Math.min(4 ** (l + 1), 400000));
    const levels = lodLevelCounts(even, 400000, 0.5);
    assert.equal(levels[0].count, 400000);
    assert.ok(levels.length > 1 && levels.length <= MAX_LEVELS);
});
