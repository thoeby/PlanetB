// The pictures the work panel shows: points through a pose, points from above,
// and a list shuffled so its prefix is a fair sample.

import test from 'node:test';
import assert from 'node:assert/strict';

import { emptySplats } from '../lib/ply.js';
import { rng } from '../lib/poly.js';
import { pointsPicture, shuffled, topDown } from '../lib/preview.js';
import { captionOf } from '../js/workui.js';

const dots = (f, at) => {
    for (let i = 0; i < f.count; i++) {
        [f.x[i], f.y[i], f.z[i]] = at(i);
        f.r[i] = 1; f.g[i] = 0.5; f.b[i] = 0;
    }
    return f;
};

test('a point in front of the camera lands in the picture, one behind does not', () => {
    const f = dots(emptySplats(2), (i) => (i ? [0, 0, 50] : [0, 0, -50]));
    const cam = { position: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0], fov: 60 };
    const pic = pointsPicture(f, cam, 64);
    let lit = 0;
    for (let i = 3; i < pic.rgba.length; i += 4) if (pic.rgba[i]) lit += 1;
    assert.equal(lit, 1);
    const centre = (32 * 64 + 32) * 4;
    assert.deepEqual([...pic.rgba.slice(centre, centre + 3)], [255, 128, 0]);
});

test('from above, the higher point wins the pixel', () => {
    const f = dots(emptySplats(2), (i) => [0, i ? 10 : 0, 0]);
    f.r[1] = 0; f.b[1] = 1;
    const pic = topDown(f, 8);
    assert.deepEqual([...pic.rgba.slice(0, 3)], [0, 128, 255]);
});

test('shuffled keeps every splat, in a different order, the same on the same seed', () => {
    const f = dots(emptySplats(50), (i) => [i, 0, 0]);
    const a = shuffled(f, rng(3));
    const b = shuffled(f, rng(3));
    assert.deepEqual([...a.x].sort((p, q) => p - q), [...f.x]);
    assert.notDeepEqual([...a.x], [...f.x]);
    assert.deepEqual([...a.x], [...b.x]);
});

test('the caption says what the picture is', () => {
    assert.equal(captionOf({ event: 'frame', done: 3, of: 20, tile: { z: 16, x: 1, y: 2 } }),
        '16/1/2 frame 3 of 20 traced');
    assert.match(captionOf({ event: 'train', iter: 400, of: 1500, splats: 600000 }), /400 of 1500/);
});
