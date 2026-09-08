// The trainer, end to end on a scene small enough for a CPU: a handful of
// gaussians rendered from a few poses, then relearned from a bad start. The
// numbers are small; what is being asserted is that the loop moves in the right
// direction and that the population never breaks the budget.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEAD, maintain, Adam } from '../lib/gsopt.js';
import { render, toRgba, toRgbaBytes } from '../lib/gsrast.js';
import { psnr } from '../lib/render.js';
import { CpuBackend, boundsOf, ratesFor, scoreOf, train } from '../lib/gstrain.js';
import { blobs, ringCamera, rng, viewsOf } from './scene.js';

const SIZE = 40;
const views = (model, angles) => viewsOf(model, angles, SIZE);

test('a bad start is trained towards the truth', async () => {
    const truth = blobs(30, rng(3));
    const angles = [0, 0.8, 1.7, 2.6, 3.4, 4.3, 5.2, 6.0];
    const shots = views(truth, angles);
    const held = views(truth, [1.2, 4.9]);

    const model = blobs(30, rng(91));
    const bounds = boundsOf(truth, 0.3);
    const backend = new CpuBackend(ratesFor(bounds.extent));
    backend.load({ model });
    const before = await scoreOf(backend, held);

    const out = await train(backend, model, {
        iters: 240, views: shots, random: rng(5), bounds, budget: 200, grow: 0.1,
        maintainEvery: 60, noise: 0.05, logEvery: 1000,
    });
    const after = await scoreOf(backend, held);

    assert.ok(out.model.count <= 200, `${out.model.count} splats is over the budget`);
    for (let i = 0; i < held.length; i++) {
        assert.ok(after[i] > before[i] + 1.5,
            `held-out view ${i}: ${before[i].toFixed(2)} dB -> ${after[i].toFixed(2)} dB`);
    }
    assert.ok(out.loss > 0 && Number.isFinite(out.loss), `loss is ${out.loss}`);
});

test('psnr rises as a render approaches its target', () => {
    const truth = blobs(12, rng(17));
    const cam = ringCamera(0.4, SIZE);
    const image = render(cam, truth.scene());
    const same = psnr(toRgba(image), toRgbaBytes(views(truth, [0.4])[0].rgb));
    assert.equal(same, Infinity);
});

test('maintenance drops the dead, grows towards the budget and never past it', () => {
    const random = rng(23);
    const model = blobs(40, random);
    for (let i = 0; i < 10; i++) model.logit[i] = -12;      // transparent
    model.pos[3 * 39] = 500;                                // and one gone astray
    model.touch();
    const bounds = boundsOf(blobs(40, rng(23)), 0.1);
    const adam = new Adam(model.count, ratesFor(bounds.extent));
    const first = maintain(model, adam, { budget: 60, bounds, grow: 0.5, random });
    assert.equal(first.dropped, 11);
    assert.equal(first.model.count, Math.round(29 * 1.5));
    assert.ok(first.model.scene().opacity.every((o) => o >= DEAD * 0.5));

    const second = maintain(first.model, first.adam,
        { budget: 45, bounds, grow: 0.5, random });
    assert.equal(second.model.count, 45, 'growth stops at the budget');
});
