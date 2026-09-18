// The seam between brush and this world, without a GPU: its buffer layout
// read into the arrays ply.js writes, its config in its own names, and the
// dataset a train atom hands it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { configFor, keep, splatsFromBrush, withSubgroups } from '../lib/brush.js';
import { SH_C0, emptySplats, readPly } from '../lib/ply.js';
import { readTar, writeTar } from '../lib/tar.js';
import { transformsJson, cameraSet } from '../lib/cameras.js';
import { EDGE_PAD_M, MARGIN, bounds, dataset, widen } from '../atoms/train.js';

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

test('a seed with no height still keeps what the run put on it', () => {
    // A tile whose ground came back as nodata is flat at exactly y = 0
    // (server/splatworld/dem.py). The seed box was then zero metres high, and
    // every splat of a finished run was dropped against it: "brush returned
    // 35903 splats and none inside the tile", over a seed spanning
    // [-846.8 0.0 -837.5 843.3 0.0 837.4].
    const seed = emptySplats(2);
    seed.x.set([-846.8, 843.3]); seed.y.set([0, 0]); seed.z.set([-837.5, 837.4]);
    const box = bounds(seed, MARGIN);
    assert.ok(box.hi[1] - box.lo[1] >= 4, `the window is ${box.hi[1] - box.lo[1]} m high`);

    const trained = emptySplats(3);
    trained.y.set([0.3, -0.4, -303.5]);   // on the ground, just under it, a floater
    trained.a.fill(1);
    assert.equal(keep(trained, box.lo, box.hi).count, 2, 'the surface stays, the floater goes');
});

test('the window stops a metre past the seed, across the ground', () => {
    // The whole reason a finished run was refused. `assemble` clips to the
    // tile plus 8 m and db/0015_structural.sql's bbox_fits accepts the tile
    // plus 10 m, so a trained tile has two metres of ground to spare — and
    // MARGIN, 15 % of a z14 tile, is 254 of them.
    const seed = emptySplats(2);
    seed.x.set([-846.8, 843.3]); seed.y.set([-75.4, 855.4]); seed.z.set([-837.5, 837.4]);
    const box = bounds(seed, MARGIN);
    const LIMIT = 856.6;                            // tile_edge_m(14,...)/2 + 10
    for (const k of [0, 2]) {
        assert.ok(Math.abs(box.lo[k] + 846.8) <= EDGE_PAD_M + 1e-9
            || Math.abs(box.lo[k] + 837.5) <= EDGE_PAD_M + 1e-9,
        `axis ${k} reaches ${box.lo[k]}`);
        assert.ok(Math.abs(box.lo[k]) < LIMIT && Math.abs(box.hi[k]) < LIMIT,
            `axis ${k} spans ${box.lo[k]}..${box.hi[k]}, outside what the rule takes`);
    }
    assert.ok(box.hi[1] - box.lo[1] > 855.4 + 75.4, 'height still gets its share');

    // And a splat brush moved ten metres off the edge is not this tile's.
    const trained = emptySplats(2);
    trained.x.set([840, 857]); trained.a.fill(1);
    assert.equal(keep(trained, box.lo, box.hi).count, 1);
});

test('a seed with height keeps the box it always had', () => {
    // 14/8554/5800 of the user's own ground: 2482.9 m at the centre, the seed
    // spanning -75.4..855.4. The floor must not widen a real tile's box.
    const seed = emptySplats(2);
    seed.x.set([-845, 845]); seed.y.set([-75.4, 855.4]); seed.z.set([-845, 845]);
    const box = bounds(seed, MARGIN);
    assert.equal(box.lo[1].toFixed(2), (-75.4 - (855.4 + 75.4) * MARGIN).toFixed(2));
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

test('refine-every is asked for when the atom says so, and left to brush when not', () => {
    // Brush grows by a fraction of what it holds at each refine, and configFor
    // stops growth at 60 % of the run. At brush's own interval a 1 200-step run
    // gets about five of them, which took a 22 500 seed to 37 000 of a 600 000
    // budget (db/0133).
    const asked = configFor({}, { iters: 1200, budget: 800000, size: 1024, refineEvery: 50 });
    assert.equal(asked['refine-every'], 50);
    assert.equal(asked['growth-stop-iter'], 720);
    assert.equal((asked['growth-stop-iter'] - asked['growth-start-iter']) / 50, 14.4,
        'fourteen chances to grow in the window, not five');

    const left = configFor({ 'refine-every': 150 }, { iters: 1200, budget: 800000, size: 1024 });
    assert.equal(left['refine-every'], 150, "brush's own number is not touched");
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

test('a shader that uses subgroups declares them, once, and nothing else is touched', () => {
    const uses = 'enable f16;\n@compute @workgroup_size(64) fn k() { let s = subgroupAdd(1.0); }';
    const fixed = withSubgroups({ label: 'k', code: uses }).code;
    assert.ok(fixed.startsWith('enable subgroups;\n'), 'the directive goes in front');
    assert.equal(withSubgroups({ code: fixed }).code, fixed, 'and only once');
    const builtin = '@compute fn k(@builtin(subgroup_invocation_id) i: u32) {}';
    assert.ok(withSubgroups({ code: builtin }).code.startsWith('enable subgroups;'));
    const plain = '@compute @workgroup_size(64) fn k() { let s = 1.0; }';
    assert.equal(withSubgroups({ code: plain }).code, plain, 'no subgroups, no directive');
    const already = 'enable subgroups, f16;\nfn k() { subgroupAdd(1.0); }';
    assert.equal(withSubgroups({ code: already }).code, already, 'declared already');
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
