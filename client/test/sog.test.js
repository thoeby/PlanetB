// WP2.6 — everything sog-v3 decides before an image codec is involved: the
// quantisation, the ranges it writes into meta.json, and the zip around them.
// client/test/e2e/sog.spec.js is the rest — the browser's WebP encoder, and
// PlayCanvas reading back what it wrote.

import test from 'node:test';
import assert from 'node:assert/strict';

import { emptySplats } from '../lib/ply.js';
import { planeDims, quantise, splatsFrom, unzip, zipStore } from '../lib/sogenc.js';
import { lodMeta } from '../atoms/sog.js';
import { cover, lodOrder } from '../lib/lodorder.js';

// A spread of splats: positions over a tile, a range of sizes, colours and
// opacities, and one rotation per quaternion mode.
function splats(n) {
    const f = emptySplats(n);
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        f.x[i] = (t - 0.5) * 800;
        f.y[i] = Math.sin(t * 9) * 40;
        f.z[i] = (0.5 - t) * 800;
        f.r[i] = t;
        f.g[i] = 1 - t;
        f.b[i] = Math.abs(0.5 - t) * 2;
        f.a[i] = 0.05 + t * 0.94;
        f.sx[i] = 0.05 + t * 3;
        f.sy[i] = 0.05 + (1 - t) * 3;
        f.sz[i] = 0.2 + t;
        const q = [0, 0, 0, 0];
        q[i % 4] = 0.9;
        q[(i + 1) % 4] = Math.sqrt(1 - 0.81);
        [f.qw[i], f.qx[i], f.qy[i], f.qz[i]] = q;
    }
    return f;
}

test('a plane is a power-of-two-wide texture holding every splat', () => {
    assert.deepEqual(planeDims(1), { width: 1, height: 1 });
    assert.deepEqual(planeDims(2304), { width: 64, height: 36 });
    assert.deepEqual(planeDims(800000), { width: 1024, height: 782 });
});

test('quantising and reading back keeps positions within the format\'s error', () => {
    const f = splats(512);
    const { meta, planes } = quantise(f);
    const back = splatsFrom(meta, planes);
    assert.equal(back.count, f.count);
    let worst = 0;
    for (let i = 0; i < f.count; i++) {
        for (const k of ['x', 'y', 'z']) {
            worst = Math.max(worst,
                Math.abs(back[k][i] - f[k][i]) / (Math.abs(f[k][i]) + 1));
        }
    }
    // Centres are log-encoded, so 16 bits buy relative precision, not absolute:
    // about 2e-4, which is 8 cm at the far corner of a 400 m tile.
    assert.ok(worst < 2e-4, `positions came back within ${worst.toExponential(2)} relative`);
});

test('colour, opacity and size survive too', () => {
    const f = splats(512);
    const { meta, planes } = quantise(f);
    const back = splatsFrom(meta, planes);
    let colour = 0;
    let alpha = 0;
    let scale = 0;
    for (let i = 0; i < f.count; i++) {
        colour = Math.max(colour, Math.abs(back.r[i] - f.r[i]), Math.abs(back.b[i] - f.b[i]));
        alpha = Math.max(alpha, Math.abs(back.a[i] - f.a[i]));
        scale = Math.max(scale, Math.abs(back.sx[i] - f.sx[i]) / f.sx[i]);
    }
    assert.ok(colour < 0.01, `colour within ${colour.toFixed(4)}`);
    assert.ok(alpha < 0.05, `opacity within ${alpha.toFixed(4)}`);
    assert.ok(scale < 0.05, `scale within ${(scale * 100).toFixed(1)}%`);
});

test('every alpha byte stays high enough to survive a canvas', () => {
    const { planes } = quantise(splats(512));
    for (const name of ['means_l', 'means_u', 'scales']) {
        const alphas = new Set();
        for (let i = 0; i < 512; i++) alphas.add(planes[name][i * 4 + 3]);
        assert.deepEqual([...alphas], [255], `${name} is opaque`);
    }
    for (let i = 0; i < 512; i++) {
        assert.ok(planes.quats[i * 4 + 3] >= 252, 'a quaternion mode byte is 252..255');
        assert.ok(planes.sh0[i * 4 + 3] >= 128,
            'the opacity byte is kept in the top half of the range');
    }
});

test('the same splats quantise to the same bytes', () => {
    const a = quantise(splats(300));
    const b = quantise(splats(300));
    assert.deepEqual(a.meta, b.meta);
    for (const name of Object.keys(a.planes)) {
        assert.deepEqual([...a.planes[name]], [...b.planes[name]]);
    }
});

test('the zip stores its entries and reads them back', () => {
    const files = [
        { name: 'meta.json', data: new TextEncoder().encode('{"version":1}') },
        { name: 'means_l.webp', data: new Uint8Array([1, 2, 3, 4, 5]) },
    ];
    const zip = zipStore(files);
    assert.equal(zip[0], 0x50, 'PK');
    const back = unzip(zip);
    assert.deepEqual([...back.keys()], ['meta.json', 'means_l.webp']);
    assert.deepEqual([...back.get('means_l.webp')], [1, 2, 3, 4, 5]);
    assert.deepEqual([...zipStore(files)], [...zip], 'no timestamps, so the same bytes');
});


// ---------------------------------------------------------------- the levels

const SHA = (c) => c.repeat(64);

test('every level is its own file, so a far tile fetches only the coarse one', () => {
    // A level names its own file (framework/parsers/gsplat-octree.js), which is
    // what makes the ladder bound the download and not only the draw.
    const levels = [{ count: 20000, cell: 0 }, { count: 5000, cell: 4 },
        { count: 1200, cell: 16 }];
    const m = lodMeta([SHA('a'), SHA('b'), SHA('c')], [0, 0, 0, 1, 1, 1], levels);
    assert.equal(m.lodLevels, 3);
    assert.deepEqual(m.filenames, [`${SHA('a')}.sog`, `${SHA('b')}.sog`, `${SHA('c')}.sog`]);
    for (let i = 0; i < 3; i++) {
        assert.equal(m.tree.lods[String(i)].file, i, 'level i is file i');
        assert.equal(m.tree.lods[String(i)].offset, 0, 'each file holds its level whole');
        assert.equal(m.tree.lods[String(i)].count, levels[i].count);
    }
    assert.equal(m.tree.children, undefined, 'a root that is itself a leaf');
});

test('level 0 is the finest: the engine sums it as the tile', () => {
    const m = lodMeta([SHA('a'), SHA('b')], [0, 0, 0, 1, 1, 1],
        [{ count: 600000, cell: 0 }, { count: 150000, cell: 3 }]);
    assert.equal(m.tree.lods['0'].count, 600000);
    assert.ok(m.tree.lods['1'].count < m.tree.lods['0'].count);
});

test('the bound is the tile, on a grid two browsers agree about', () => {
    const box = [-845.123456, -1.5, -837.987654, 845.1, 193.777, 837.4];
    const m = lodMeta([SHA('a')], box, [{ count: 10, cell: 0 }]);
    assert.deepEqual(m.tree.bound.min, [-845.12, -1.5, -837.99]);
    assert.deepEqual(m.tree.bound.max, [845.1, 193.78, 837.4]);
    assert.equal(JSON.stringify(m),
        JSON.stringify(lodMeta([SHA('a')], box, [{ count: 10, cell: 0 }])),
        'and the same bytes twice');
});

test('no errors are written: the engine derives them from the counts', () => {
    const m = lodMeta([SHA('a')], [0, 0, 0, 1, 1, 1], [{ count: 100, cell: 0 }]);
    assert.equal(m.tree.errors, undefined);
    assert.equal(m.lodErrors, undefined);
});

test('a coarse level is widened to the ground it has to cover', () => {
    // A quarter as many splats at the same size is a sieve, not a coarser
    // tile. The thin axis is through the surface and is left alone.
    const f = emptySplats(2);
    f.sx.set([0.5, 3]); f.sy.set([0.0625, 0.125]); f.sz.set([0.5, 3]);
    cover(f, 2);
    assert.deepEqual([...f.sx], [2, 3], 'widened to the voxel, never shrunk');
    assert.deepEqual([...f.sz], [2, 3]);
    assert.deepEqual([...f.sy], [0.0625, 0.125], 'and never through the surface');

    const g = emptySplats(1);
    g.sx.set([0.5]); g.sy.set([0.0625]); g.sz.set([0.5]);
    cover(g, 0);
    assert.deepEqual([...g.sx], [0.5], 'the finest level covers nothing new');
});

test('the levels a tile publishes carry the voxel they speak for', () => {
    const { levels } = lodOrder(splats(20000));
    assert.equal(levels[0].cell, 0, 'the finest widens nothing');
    for (let i = 1; i < levels.length; i++) {
        assert.ok(levels[i].count < levels[i - 1].count, 'coarser as the index rises');
        assert.ok(levels[i].cell > 0, 'and each says how far its splats must reach');
    }
});
