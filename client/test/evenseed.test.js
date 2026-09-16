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
