// The seam between brush and this world, without a GPU: its buffer layout
// read into the arrays ply.js writes, its config in its own names, and the
// dataset a train atom hands it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { configFor, keep, splatsFromBrush } from '../lib/brush.js';
import { SH_C0, emptySplats, readPly } from '../lib/ply.js';
import { readTar, writeTar } from '../lib/tar.js';
import { transformsJson, cameraSet } from '../lib/cameras.js';
import { dataset, widen } from '../atoms/train.js';

const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('brush rows become splats: means, xyzw rotation, log scales, sh0, logit', () => {
    const transforms = new Float32Array([1, 2, 3, 0.1, 0.2, 0.3, 0.9, Math.log(0.5),
        Math.log(2), 0]);
    const sh = new Float32Array([(0.7 - 0.5) / SH_C0, (0.2 - 0.5) / SH_C0, 0]);
    const opac = new Float32Array([0]);
    const f = splatsFromBrush({ transforms, sh, opac, count: 1, coeffs: 1 });
    near(f.x[0], 1); near(f.z[0], 3);
    near(f.qw[0], 0.9); near(f.qx[0], 0.1); near(f.qz[0], 0.3);
    near(f.sx[0], 0.5); near(f.sy[0], 2); near(f.sz[0], 1);
    near(f.r[0], 0.7); near(f.g[0], 0.2); near(f.b[0], 0.5);
    near(f.a[0], 0.5);
});

test('higher sh bands are skipped: colour is the first coefficient of each', () => {
    const coeffs = 4;
    const sh = new Float32Array(coeffs * 3).fill(9);
    sh[0] = 0; sh[1] = 0; sh[2] = (1 - 0.5) / SH_C0;
    const f = splatsFromBrush({ transforms: new Float32Array(10), sh,
        opac: new Float32Array(1), count: 1, coeffs });
    near(f.r[0], 0.5); near(f.b[0], 1);
});

test('keep drops what left the box, went transparent or is not a number', () => {
    const f = emptySplats(4);
    f.x.set([0, 5, 0, 0]); f.a.set([1, 1, 0, 1]); f.y[3] = NaN;
    f.sx.fill(1); f.sy.fill(1); f.sz.fill(1); f.qw.fill(1);
    const out = keep(f, [-1, -1, -1], [1, 1, 1]);
    assert.equal(out.count, 1);
});

test('the config speaks brush: iterations, budget, growth to the budget, no eval split', () => {
    const c = configFor({ 'lr-mean': 1, 'refine-every': 200 }, { iters: 1500, budget: 600000,
        size: 512 });
    assert.equal(c['total-train-iters'], 1500);
    assert.equal(c['max-splats'], 600000);
    assert.equal(c['growth-stop-iter'], 900, 'grows for the first 60 %');
    assert.equal(c['sh-degree'], 0);
    assert.equal(c['eval-split-every'], null);
    assert.equal(c['refine-every'], 200, 'what brush proposed and this does not touch stays');
});

test('widen makes a splat bigger across the surface and not through it', () => {
    const f = emptySplats(2);
    f.sx.set([0.5, 0.1]); f.sy.set([0.1, 0.4]); f.sz.set([0.4, 0.3]);
    widen(f, 2);
    near(f.sx[0], 1); near(f.sy[0], 0.1); near(f.sz[0], 0.8);
    near(f.sx[1], 0.1); near(f.sy[1], 0.8); near(f.sz[1], 0.6);
});

test('widening by one, or by nothing, leaves the splats alone', () => {
    const f = emptySplats(1);
    f.sx[0] = 0.5; f.sy[0] = 0.1; f.sz[0] = 0.4;
    widen(widen(f, 1), 0);
    near(f.sx[0], 0.5); near(f.sz[0], 0.4);
});

test('the dataset holds every frame but the held-out ones, and names the seed', () => {
    const cams = cameraSet('z16-v1', { centre: [0, 0, 0], extent: 100 });
    const chunk = (from, to) => {
        const c = cams.slice(from, to);
        const names = c.map((k) => `frame_${String(k.id).padStart(4, '0')}.webp`);
        return writeTar([
            ...names.map((n) => ({ name: n, bytes: new Uint8Array([1, 2, 3]) })),
            { name: 'transforms.json', bytes: new TextEncoder().encode(
                JSON.stringify(transformsJson(c, 64, names))) },
        ]);
    };
    const seed = emptySplats(3);
    seed.sx.fill(1); seed.sy.fill(1); seed.sz.fill(1); seed.qw.fill(1); seed.a.fill(1);
    const ds = dataset([chunk(0, 20), chunk(20, 40), chunk(40, 56)], 'z16-v1', seed);
    assert.equal(ds.held, 4);
    assert.equal(ds.views, 52);
    const t = JSON.parse(new TextDecoder().decode(
        ds.files.find((f) => f.name === 'transforms.json').bytes));
    assert.equal(t.ply_file_path, 'init.ply');
    assert.equal(t.frames.length, 52);
    assert.equal(t.w, 64, 'the intrinsics of the first chunk are kept');
    assert.equal(ds.files.filter((f) => f.name.endsWith('.webp')).length, 52);
    const ply = readPly(ds.files.find((f) => f.name === 'init.ply').bytes);
    assert.equal(ply.count, 3);
    // The tars still read as tars, so nothing was consumed.
    assert.ok(readTar(chunk(0, 20)).has('transforms.json'));
});
