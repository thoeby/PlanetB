// The seed's samples are spread evenly within a triangle (train-v6): the
// nearest neighbour of the loneliest sample is far closer than it is under
// uniformly random placement, which is what left patches of the tile with no
// splat in them at all.
import test from 'node:test';
import assert from 'node:assert/strict';

import { rng } from '../lib/poly.js';
import { sampleSurfaces } from '../lib/sampling.js';

// One big flat triangle, 400 samples.
const tri = {
    positions: new Float32Array([0, 0, 0, 100, 0, 0, 0, 0, 100]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    colors: new Float32Array(9).fill(0.5),
    indices: new Uint32Array([0, 1, 2]),
    material: 'ground',
};

// The largest gap: the greatest distance from any sample to its nearest
// neighbour. A void is a sample whose neighbours are all far away.
function largestGap(f) {
    let worst = 0;
    for (let i = 0; i < f.count; i++) {
        let near = Infinity;
        for (let j = 0; j < f.count; j++) {
            if (i === j) continue;
            const d = (f.x[i] - f.x[j]) ** 2 + (f.z[i] - f.z[j]) ** 2;
            if (d < near) near = d;
        }
        worst = Math.max(worst, near);
    }
    return Math.sqrt(worst);
}

test('an even seed has no voids a random one has', () => {
    const random = sampleSurfaces([tri], 400, rng(7));
    const even = sampleSurfaces([tri], 400, rng(7), { even: true });
    assert.equal(even.count, 400);
    const spacing = Math.sqrt(5000 / 400);
    assert.ok(largestGap(even) < spacing * 1.5, `even: ${largestGap(even)} vs spacing ${spacing}`);
    assert.ok(largestGap(random) > largestGap(even) * 1.3, 'random placement leaves larger gaps');
});

test('the same seed is the same seed', () => {
    const a = sampleSurfaces([tri], 50, rng(3), { even: true });
    const b = sampleSurfaces([tri], 50, rng(3), { even: true });
    assert.deepEqual([...a.x], [...b.x]);
    assert.deepEqual([...a.z], [...b.z]);
});

// Two triangles of the same area: one smooth and one colour of ground, one
// with its colours and normals pulling apart the way an edge does.
const flat = {
    positions: new Float32Array([0, 0, 0, 100, 0, 0, 0, 0, 100]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    colors: new Float32Array(9).fill(0.5),
    indices: new Uint32Array([0, 1, 2]),
    material: 'ground',
};
const busy = {
    positions: new Float32Array([200, 0, 0, 300, 0, 0, 200, 0, 100]),
    normals: new Float32Array([0, 1, 0, 0.7, 0.7, 0, 0, 0.7, 0.7]),
    colors: new Float32Array([0, 0, 0, 1, 1, 1, 1, 0, 0]),
    indices: new Uint32Array([0, 1, 2]),
    material: 'ground',
};

test('smooth ground is covered, not starved to pay for the edges', () => {
    // detailOf runs from 1 on flat uniform ground to about 16 on an edge, so
    // weighting by area x detail alone gave the hillside a sixteenth of its
    // share. What covered it was the size of the few splats it got -- one per
    // triangle, grown until it reached its neighbour -- which is the overlap
    // that reads as a smear. Cut the overlap and the thin places are holes.
    const f = sampleSurfaces([flat, busy], 2000, rng(5), { spread: 0.5, even: true });
    let onFlat = 0;
    for (let i = 0; i < f.count; i++) if (f.x[i] < 150) onFlat++;
    assert.ok(onFlat > f.count * 0.33,
        `the smooth half got ${onFlat} of ${f.count}: it is being starved`);
    assert.ok(onFlat < f.count * 0.5,
        `the smooth half got ${onFlat} of ${f.count}: detail is being ignored`);
});
