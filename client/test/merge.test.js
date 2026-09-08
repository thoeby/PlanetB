// WP2.5 — the deterministic half of merge-v1: the voxel grid. Invariant 7 says
// a merged tile must come out bit-identical wherever it is computed, and this
// is where that is decided: integer keys, a fixed fold order, and a top-k that
// breaks its ties on the key rather than on whatever the sort happened to do.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Grid } from '../atoms/merge.js';
import { writePly } from '../lib/ply.js';

const ORIGIN = { lon: 8, lat: 47, h: 400 };

// A cloud of splats, spread over `span` metres, from a seed.
function cloud(n, span, seed) {
    let a = seed >>> 0;
    const rnd = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return Array.from({ length: n }, () => ({
        p: [(rnd() - 0.5) * span, (rnd() - 0.5) * span * 0.1, (rnd() - 0.5) * span],
        c: [rnd(), rnd(), rnd(), 0.5 + rnd() / 2],
        s: [0.2 + rnd(), 0.2 + rnd(), 0.2 + rnd()],
        q: [1, 0, 0, 0],
    }));
}

const foldAll = (grid, pts) => {
    for (const s of pts) grid.fold(s.p, s.c, s.s, s.q, s.c[3] * s.s[0] * s.s[2]);
};

test('splats in the same voxel become one cluster, in key order', () => {
    const grid = new Grid(10, ORIGIN);
    // Four splats, two of them in the same 10 m cell.
    grid.fold([1, 0, 1], [1, 0, 0, 1], [1, 1, 1], [1, 0, 0, 0], 1);
    grid.fold([2, 0, 3], [0, 1, 0, 1], [1, 1, 1], [1, 0, 0, 0], 1);
    grid.fold([25, 0, 0], [0, 0, 1, 1], [1, 1, 1], [1, 0, 0, 0], 3);
    grid.fold([-40, 0, 0], [1, 1, 1, 1], [1, 1, 1], [1, 0, 0, 0], 2);
    const f = grid.finish(100);
    assert.equal(f.count, 3, 'four splats, three cells');
    assert.deepEqual([...f.x], [-40, 1.5, 25], 'written in key order, west first');
    assert.ok(Math.abs(f.r[1] - 0.5) < 1e-12, 'the pair averaged, weighted');
    assert.ok(f.sx.every((s) => s >= 5), 'a cluster is at least half a voxel wide');
});

test('the same splats fold to the same bytes however many times it is run', () => {
    const pts = cloud(4000, 300, 11);
    const runs = [0, 1].map(() => {
        const g = new Grid(3, ORIGIN);
        foldAll(g, pts);
        return writePly(g.finish(5000));
    });
    assert.deepEqual([...runs[0]], [...runs[1]]);

    // And folding the children in the same order from different starting
    // states — which is what two workers do — lands in the same place.
    const split = new Grid(3, ORIGIN);
    foldAll(split, pts.slice(0, 1500));
    foldAll(split, pts.slice(1500));
    assert.deepEqual([...writePly(split.finish(5000))], [...runs[0]]);
});

test('the budget is a cap, and the heaviest clusters are the ones that survive', () => {
    const pts = cloud(3000, 400, 5);
    const grid = new Grid(2, ORIGIN);
    foldAll(grid, pts);
    assert.ok(grid.keys.length > 500, `${grid.keys.length} clusters before the cap`);

    assert.equal(grid.finish(1e6).count, grid.keys.length, 'no cap, nothing dropped');
    assert.equal(grid.finish(200).count, 200, 'a cap is a cap');

    // With room for one, the one that survives is the heaviest cluster there is.
    const weights = grid.keys.map((_, i) => grid.data[i * 16]);
    const top = weights.indexOf(Math.max(...weights));
    const one = grid.finish(1);
    assert.equal(one.count, 1);
    // The splats are float32; the accumulator is double.
    assert.ok(Math.abs(one.x[0] - grid.data[top * 16 + 1] / weights[top]) < 1e-3);
    assert.ok(Math.abs(one.z[0] - grid.data[top * 16 + 3] / weights[top]) < 1e-3);
});

test('a cluster keeps the orientation of its heaviest member', () => {
    const grid = new Grid(10, ORIGIN);
    grid.fold([0, 0, 0], [1, 1, 1, 1], [1, 1, 1], [0, 1, 0, 0], 1);
    grid.fold([1, 0, 1], [1, 1, 1, 1], [1, 1, 1], [0, 0, 1, 0], 9);
    grid.fold([2, 0, 2], [1, 1, 1, 1], [1, 1, 1], [0, 0, 0, 1], 4);
    const f = grid.finish(10);
    assert.equal(f.count, 1);
    assert.deepEqual([f.qw[0], f.qx[0], f.qy[0], f.qz[0]], [0, 0, 1, 0]);
});
