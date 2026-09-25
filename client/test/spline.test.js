// EDT.12 — the line library: a curve through smooth nodes, kinks at corners,
// densified to a metre or five degrees, a sketch simplified to nodes, and the
// cuts and joins the edit tools make.
import test from 'node:test';
import assert from 'node:assert/strict';

import { curve, densify, dist, frameAt, join, length, nearest, reverse, simplify, split,
    toSegment } from '../lib/spline.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('the curve passes through every node; corners are kinks, ends are straight', () => {
    const nodes = [[0, 0], [10, 0], [20, 10], [30, 10]];
    const c = curve(nodes, [], 0.5);
    for (const n of nodes) assert.ok(c.some((p) => dist(p, n) < 1e-9), `through ${n}`);
    // Between two corners the curve is the straight segment.
    const k = curve([[0, 0], [10, 0], [10, 10]], [false, true, false], 0.5);
    for (const p of k.filter((q) => q[1] === 0 || q[0] < 9.99)) {
        assert.ok(near(p[1], 0, 1e-9) || near(p[0], 10, 1e-9), `on a leg: ${p}`);
    }
    // A smooth node takes the same corner as a curve: off both legs.
    const s = curve([[0, 0], [10, 0], [10, 10]], [], 0.5);
    assert.ok(s.some((p) => Math.abs(p[1]) > 0.1 && Math.abs(p[0] - 10) > 0.1));
});

test('densify: a point every metre on the straight, more where it turns', () => {
    const straight = densify([[0, 0], [20, 0]]);
    assert.equal(straight.length, 21);
    assert.ok(near(straight[7][0], 7, 1e-6), 'a straight line at every metre');
    for (let i = 1; i < straight.length; i++) {
        assert.ok(dist(straight[i - 1], straight[i]) <= 1 + 1e-6);
    }
    // A tight bend: more points than metres.
    const bend = densify([[0, 0], [4, 0], [4, 4]]);
    assert.ok(bend.length > length(bend) + 1, `${bend.length} for ${length(bend)} m`);
    // The nodes are kept exactly.
    assert.ok(bend.some((p) => dist(p, [4, 0]) < 1e-9));
});

test('a sketch becomes the few nodes that stay within half a metre', () => {
    const sketch = [];
    for (let x = 0; x <= 50; x += 0.5) sketch.push([x, Math.sin(x / 50 * Math.PI) * 0.2]);
    for (let z = 0; z <= 30; z += 0.5) sketch.push([50, z]);
    const s = simplify(sketch, 0.5);
    assert.ok(s.length <= 4, `${s.length} nodes`);
    assert.deepEqual(s[0], [0, 0]);
    assert.deepEqual(s.at(-1), [50, 30]);
    for (const p of sketch) {
        let d = Infinity;
        for (let i = 0; i + 1 < s.length; i++) d = Math.min(d, toSegment(p, s[i], s[i + 1]).d);
        assert.ok(d <= 0.5 + 1e-9);
    }
});

test('length, nearest point, and how far along it is', () => {
    const l = [[0, 0], [10, 0], [10, 10]];
    assert.equal(length(l), 20);
    const n = nearest(l, [12, 4]);
    assert.equal(n.i, 1);
    assert.ok(near(n.d, 2) && near(n.along, 14));
    assert.deepEqual(n.point, [10, 4]);
});

test('split keeps the node in both halves; join turns lines round to meet', () => {
    const line = { nodes: [[0, 0], [5, 0], [10, 0], [15, 0]], corner: [false, true, false, false] };
    const [a, b] = split(line.nodes, line.corner, 2);
    assert.deepEqual(a.nodes, [[0, 0], [5, 0], [10, 0]]);
    assert.deepEqual(b.nodes, [[10, 0], [15, 0]]);
    assert.deepEqual(a.corner, [false, true, false]);
    assert.equal(split(line.nodes, line.corner, 0), null);
    const back = join(a, reverse(b));
    assert.deepEqual(back.nodes, line.nodes);
    assert.deepEqual(back.corner, line.corner);
    assert.equal(join(a, { nodes: [[40, 40], [50, 50]], corner: [] }), null);
});

test('the frame goes to metres and back', () => {
    const f = frameAt(7.88, 46.3);
    const [x, z] = f.toXZ(7.881, 46.299);
    assert.ok(x > 0 && z > 0, 'east and south are positive');
    const g = f.toLonLat([x, z]);
    assert.ok(near(g.lon, 7.881, 1e-12) && near(g.lat, 46.299, 1e-12));
});
