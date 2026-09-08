// The frames a tile was rendered from, and the poses held back from training.
// `train` and `verify` have to agree about both or a verification is comparing
// two different pictures (client/lib/frames.js).

import test from 'node:test';
import assert from 'node:assert/strict';

import { cameraSet, transformsJson, viewCount } from '../lib/cameras.js';
import { holdout, loadFrames, shrink } from '../lib/frames.js';
import { posesFor } from '../atoms/verify.js';
import { writeTar } from '../lib/tar.js';

test('a frame is reduced by whole blocks, and averaged', () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
        rgba.set([i * 16, 255 - i * 16, 7, 255], i * 4);
    }
    const out = shrink(rgba, 4, 2);
    assert.equal(out.length, 2 * 2 * 3);
    // The top-left block is pixels 0, 1, 4, 5: reds 0, 16, 64, 80.
    assert.equal(out[0], Math.round((0 + 16 + 64 + 80) / 4));
    assert.equal(out[2], 7, 'a channel that never varies survives');
});

test('a size that is not a whole factor falls back to sampling', () => {
    const rgba = new Uint8ClampedArray(3 * 3 * 4).fill(9);
    const out = shrink(rgba, 3, 2);
    assert.equal(out.length, 2 * 2 * 3);
    assert.ok(out.every((v) => v === 9));
});

test('four poses are held back, spread across the set', () => {
    for (const set of ['z16-v1', 'z18-v1']) {
        const n = viewCount(set);
        const held = holdout(n);
        assert.equal(held.length, 4);
        assert.deepEqual([...new Set(held)], held, `${set}: distinct poses`);
        assert.ok(held.every((p) => p >= 0 && p < n), `${set}: inside the set`);
        assert.ok(held[1] - held[0] > n / 8, `${set}: spread out, not adjacent`);
    }
});

test('the three verify atoms between them cover every held-out pose', () => {
    const params = (index) => ({ camera_set: 'z16-v1', index });
    const seen = new Set([1, 2, 3].flatMap((i) => posesFor(params(i))));
    assert.deepEqual([...seen].sort((a, b) => a - b), holdout(viewCount('z16-v1')));
    assert.deepEqual(posesFor(params(1)).length, 2);
    assert.notDeepEqual(posesFor(params(1)), posesFor(params(2)));
});

// One frame atom's tar, as frame-v1 writes it, with a solid colour per pose.
function fakeTar(ids, size) {
    const cams = cameraSet('z16-v1', { centre: [0, 0, 0], extent: 50 })
        .filter((c) => ids.includes(c.id));
    const names = cams.map((c) => `frame_${String(c.id).padStart(4, '0')}.webp`);
    return { bytes: writeTar([...names.map((name, i) => ({ name,
        bytes: new Uint8Array([i + 1]) })),
    { name: 'transforms.json',
        bytes: new TextEncoder().encode(JSON.stringify(transformsJson(cams, size, names))) }]),
    cams };
}

test('only the poses asked for are decoded, and each keeps its camera', async () => {
    const { bytes } = fakeTar([0, 1, 2, 3], 64);
    const decoded = [];
    const decode = async (raw) => {
        decoded.push(raw[0]);
        return { data: new Uint8ClampedArray(64 * 64 * 4).fill(raw[0]), size: 64 };
    };
    const { views } = await loadFrames([bytes], { decode, size: 32, only: [1, 3] });
    assert.deepEqual(views.map((v) => v.id), [1, 3]);
    assert.deepEqual(decoded.sort(), [2, 4]);
    assert.equal(views[0].rgb.length, 32 * 32 * 3);
    assert.equal(views[0].cam.width, 32, 'the intrinsics come down with the frame');
    assert.ok(Math.abs(views[0].cam.fx - views[0].cam.fy) < 1e-6);
});
