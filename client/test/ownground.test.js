// A trained tile keeps the splats over its own ground and no one else's
// (client/atoms/train.js ownGround): two tiles meet at the edge they share in
// lon/lat, with neither's splats lying over the other's.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ownGround } from '../atoms/train.js';
import { emptySplats } from '../lib/ply.js';
import { localFromLonLat, tileBbox, tileFrame } from '../lib/tilemath.js';

test('a splat past the tile\'s edge is dropped, one just inside is kept', () => {
    const [z, x, y] = [14, 8540, 5795];
    const frame = tileFrame(z, x, y, 1200);
    const b = tileBbox(z, x, y);
    const west = localFromLonLat(frame, b.west, (b.south + b.north) / 2, 1200).x;
    const north = localFromLonLat(frame, (b.west + b.east) / 2, b.north, 1200).z;
    const f = emptySplats(4);
    f.a.fill(1);
    f.x.set([0, west + 0.5, west - 0.5, 0]);
    f.z.set([0, 0, 0, north - 0.5]);
    ownGround(f, frame, b);
    assert.deepEqual([...f.a], [1, 1, 0, 0],
        'the middle and just inside the west edge stay; past west and past north go');
});

test('neighbours partition the seam between them', () => {
    const z = 14;
    const a = tileFrame(z, 8540, 5795, 0);
    const b = tileFrame(z, 8541, 5795, 0);
    // Points along the shared edge, a little either side, each owned once.
    const edge = tileBbox(z, 8540, 5795).east;
    for (const d of [-1e-6, 1e-6]) {
        const p = localFromLonLat(a, edge + d, a.lat, 0);
        const q = localFromLonLat(b, edge + d, b.lat, 0);
        const fa = emptySplats(1); fa.a.fill(1); fa.x[0] = p.x; fa.y[0] = p.y; fa.z[0] = p.z;
        const fb = emptySplats(1); fb.a.fill(1); fb.x[0] = q.x; fb.y[0] = q.y; fb.z[0] = q.z;
        ownGround(fa, a, tileBbox(z, 8540, 5795));
        ownGround(fb, b, tileBbox(z, 8541, 5795));
        assert.equal(fa.a[0] + fb.a[0], 1, `exactly one tile keeps the point at ${d}`);
    }
});

// Two tiles on one slope meet at the same height: the edge is extrapolated
// from the edge pair, not held at the last pixel centre (geo.js sampleHeight).
test('two rasters on one slope agree on the height of the edge between them', async () => {
    const { sampleHeight } = await import('../lib/geo.js');
    const n = 4;
    // h = 10 * x across two side-by-side tiles, each x in [0, 1) and [1, 2).
    const raster = (x0) => ({ size: n, u0: 0, v0: 0, span: 1,
        data: Float32Array.from({ length: n * n }, (_, k) => 10 * (x0 + ((k % n) + 0.5) / n)) });
    const left = sampleHeight(raster(0), 1, 0.5);
    const right = sampleHeight(raster(1), 0, 0.5);
    assert.ok(Math.abs(left - 10) < 1e-4 && Math.abs(right - 10) < 1e-4,
        `both sides say 10 at the seam: ${left}, ${right}`);
});
