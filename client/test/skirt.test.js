import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Mesh } from '../lib/mesh.js';
import { skirt } from '../lib/skirt.js';

// A 3 x 3 grid, 1 m apart, rising 0.5 m a metre in x.
function slope() {
    const m = new Mesh('terrain');
    for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) m.vertex([i, i * 0.5, j], [0, 1, 0], [i / 2, 0, j / 2]);
    }
    m.tri(0, 3, 1);
    return m;
}

const bbox = (m) => [0, 1, 2].map((k) => {
    const v = m.positions.filter((_, i) => i % 3 === k);
    return [Math.min(...v), Math.max(...v)];
});

test('the skirt carries the ground past every edge, along its own slope', () => {
    const m = skirt(slope(), 3, 2);
    const [x, y, z] = bbox(m);
    assert.deepEqual(x, [-2, 4]);
    assert.deepEqual(z, [-2, 4]);
    assert.deepEqual(y, [-1, 2], 'the height goes on at the edge\'s slope, not flat');
    assert.equal(m.vertexCount, 9 + 4 * 3 + 4 * 3, 'one vertex per edge vertex, three per corner');
    assert.equal(m.indices.length / 3, 1 + 4 * 2 * 2 + 4 * 2);
    assert.ok(m.indices.every((i) => i < m.vertexCount));
});

test('a skirt vertex has the colour of the edge it continues', () => {
    const m = skirt(slope(), 3, 1);
    const last = m.vertexCount - 1;
    const byPos = (x, z) => {
        for (let v = 0; v < m.vertexCount; v++) {
            if (m.positions[v * 3] === x && m.positions[v * 3 + 2] === z) return v;
        }
        return -1;
    };
    const out = byPos(3, 1);
    assert.ok(out > 8 && out <= last);
    assert.deepEqual(m.colors.slice(out * 3, out * 3 + 3), [1, 0, 0.5]);
});

test('no width, no skirt', () => {
    assert.equal(skirt(slope(), 3, 0).vertexCount, 9);
});
