// WP2.4 — the camera sets, and the matrices that describe them. These numbers
// are shared with the database: camera_views() in db/0005_jobs.sql hands out
// 120 views for z18 and 56 for z16, and the DAG chunks them 20 at a time.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SETS, cameraSet, cameraToWorld, perspective, transformsJson, viewCount, viewMatrix,
} from '../lib/cameras.js';
import { psnr } from '../lib/render.js';
import { boundsOf } from '../atoms/frame.js';

const BOUNDS = { centre: [0, 0, 0], extent: 100 };

test('the sets are the ones the DAG counts on', () => {
    assert.equal(viewCount('z18-v1'), 120, '3 rings x 24 + 16 targets x 2 obliques + 16 top');
    assert.equal(viewCount('z16-v1'), 56, '2 rings x 24 + 8 top');
    assert.equal(viewCount('z16-v2'), 45, '9 stations, each nadir + 4 sides');
    for (const name of Object.keys(SETS)) {
        const cams = cameraSet(name, BOUNDS);
        assert.equal(cams.length, viewCount(name));
        assert.deepEqual(cams.map((c) => c.id), cams.map((_, i) => i),
            'a pose id is its index in the set');
    }
});

test('a set is the same list every time, and every pose looks somewhere', () => {
    const a = cameraSet('z18-v1', BOUNDS);
    const b = cameraSet('z18-v1', BOUNDS);
    assert.deepEqual(a, b);
    assert.equal(a.filter((c) => c.kind === 'ring').length, 72);
    assert.equal(a.filter((c) => c.kind === 'oblique').length, 32);
    assert.equal(a.filter((c) => c.kind === 'top').length, 16);
    for (const c of a) {
        assert.ok(c.position.every(Number.isFinite));
        assert.notDeepEqual(c.position, c.target);
        assert.ok(c.position[1] > BOUNDS.centre[1], 'nothing is underground');
    }
});

test('obliques stand over the ground and top-downs are above everything', () => {
    const cams = cameraSet('z18-v1', BOUNDS);
    for (const c of cams.filter((v) => v.kind === 'oblique')) {
        assert.ok(c.position[1] >= 2 && c.position[1] < 60, `oblique at ${c.position[1]}`);
    }
    for (const c of cams.filter((v) => v.kind === 'top')) {
        assert.equal(c.position[1], 160);
        assert.deepEqual([c.target[0], c.target[2]], [c.position[0], c.position[2]],
            'straight down');
    }
});

test('camera-to-world is OpenGL: +X right, +Y up, looking down -Z', () => {
    const cam = { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 60, id: 0 };
    const m = cameraToWorld(cam);
    assert.deepEqual(m[0], [1, 0, 0, 0]);
    assert.deepEqual(m[1], [0, 1, 0, 0]);
    assert.deepEqual(m[2], [0, 0, 1, 10], 'the camera sits 10 up the +Z axis');
    assert.deepEqual(m[3], [0, 0, 0, 1]);
});

test('the view matrix puts the camera at the origin', () => {
    const cam = { position: [30, 12, -4], target: [0, 0, 0], up: [0, 1, 0], fov: 60, id: 0 };
    const v = viewMatrix(cam);
    const p = cam.position;
    const eye = [0, 1, 2].map((r) =>
        v[r] * p[0] + v[4 + r] * p[1] + v[8 + r] * p[2] + v[12 + r]);
    // The matrix is float32, so a 30 m eye lands within a tenth of a millimetre.
    for (const c of eye) assert.ok(Math.abs(c) < 1e-4, `${eye} is the origin`);
});

test('a perspective matrix sends the near plane to -1 and the far plane to +1', () => {
    const p = perspective(60, 1, 1, 100);
    const depth = (z) => {
        const w = -z;
        return (p[10] * z + p[14]) / w;
    };
    assert.ok(Math.abs(depth(-1) + 1) < 1e-6);
    assert.ok(Math.abs(depth(-100) - 1) < 1e-6);
});

test('transforms.json is nerfstudio-shaped and names every frame', () => {
    const cams = cameraSet('z16-v1', BOUNDS).slice(20, 24);
    const files = cams.map((c) => `frame_${String(c.id).padStart(4, '0')}.webp`);
    const t = transformsJson(cams, 1024, files);
    assert.equal(t.camera_model, 'OPENCV');
    assert.equal(t.w, 1024);
    assert.ok(Math.abs(t.fl_x - 512 / Math.tan(Math.PI / 6)) < 1e-9);
    assert.equal(t.frames.length, 4);
    assert.equal(t.frames[0].pose_id, 20, 'a chunk keeps the set-wide pose ids');
    assert.equal(t.frames[0].file_path, 'frame_0020.webp');
    assert.equal(t.frames[0].transform_matrix.length, 4);
});

test('bounds are the middle of the ground and how far the scene reaches', () => {
    const meshes = [{ positions: new Float32Array([-50, 10, -50, 50, 30, 50, 0, 20, 0]) }];
    const b = boundsOf(meshes);
    assert.deepEqual([b.centre[0], b.centre[2]], [0, 0]);
    assert.equal(b.centre[1], 12, 'a tenth of the way up, not at the lowest point');
    assert.equal(b.extent, 50);
});

test('psnr is infinite for identical frames and falls as they differ', () => {
    const a = new Uint8ClampedArray(64).fill(120);
    const b = Uint8ClampedArray.from(a);
    assert.equal(psnr(a, b), Infinity);
    b[0] = 121;
    assert.ok(psnr(a, b) > 45, `one count of drift is ${psnr(a, b).toFixed(1)} dB`);
    for (let i = 0; i < b.length; i++) b[i] = i % 4 === 3 ? a[i] : 20;
    assert.ok(psnr(a, b) < 20, 'a different image is not a rounding difference');
});

// A camera stands on the ground it is over: in a valley the street loop would
// otherwise be underground and the rings would look through the hill.
test('with ground given, every pose is above it and the street loop is at eye height', () => {
    const ground = (x, z) => 40 + 0.5 * x + 0.2 * z;      // a slope through the middle
    const cams = cameraSet('z18-v1', BOUNDS, ground);
    assert.equal(cams.length, viewCount('z18-v1'));
    for (const c of cams) {
        const under = ground(c.position[0], c.position[2]);
        assert.ok(c.position[1] > under + 1, `${c.kind} ${c.id}: ${c.position[1]} over ${under}`);
    }
    for (const c of cams.filter((k) => k.kind === 'oblique')) {
        assert.ok(c.position[1] - ground(c.position[0], c.position[2]) >= 2 - 1e-9);
    }
    assert.deepEqual(cameraSet('z18-v1', BOUNDS), cameraSet('z18-v1', BOUNDS, null),
        'without ground, the set is what it was');
});

// z16-v2: stations across the tile, not rings round its middle. Every part of
// the ground is under a nadir whose footprint overlaps its neighbours', and
// is looked at from four sides from close; nothing stands below the ground.
test('z16-v2 covers the tile from stations, above the ground', () => {
    const cams = cameraSet('z16-v2', { centre: [0, 0, 0], extent: 850 }, () => 0);
    assert.equal(cams.length, 45);
    const nadir = cams.filter((c) => c.kind === 'top');
    const sides = cams.filter((c) => c.kind === 'oblique');
    assert.equal(nadir.length, 9); assert.equal(sides.length, 36);
    const xs = new Set(nadir.map((c) => Math.round(c.position[0])));
    assert.deepEqual([...xs].sort((a, b) => a - b), [-567, 0, 567], 'three columns across the tile');
    // A 60° footprint from 980 m is 1130 m wide over a 567 m spacing: half overlap.
    for (const c of nadir) assert.ok(c.position[1] > 900 && c.position[1] < 1100);
    for (const c of sides) {
        assert.ok(c.position[1] > 300 && c.position[1] < 400, 'obliques are close to the ground');
        const dx = c.position[0] - c.target[0]; const dz = c.position[2] - c.target[2];
        const pitch = Math.atan2(c.position[1], Math.hypot(dx, dz)) * 180 / Math.PI;
        assert.ok(Math.abs(pitch - 55) < 1, `55° down, not ${pitch}`);
    }
    const hilly = cameraSet('z16-v2', { centre: [0, 0, 0], extent: 850 }, () => 900);
    for (const c of hilly) assert.ok(c.position[1] >= 905, 'never in the hill');
});
