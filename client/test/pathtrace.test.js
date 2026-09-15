// The frame atom's scene, without a GPU: the meshes, the sky and sun, the
// cameras and the placed assets are built with three.js in node; only the
// tracing itself needs WebGL (client/test/e2e/frame.spec.js).

import test from 'node:test';
import assert from 'node:assert/strict';

import { cameraSet, cameraToWorld } from '../lib/cameras.js';
import { basisOf } from '../lib/glbmesh.js';
import { SKY_COLOUR, SUN } from '../lib/light.js';
import {
    cameraOf, meshObject, placeObject, poseOf, skyAndSun, toBytes,
} from '../lib/pathtrace.js';
import { tileFrame } from '../lib/tilemath.js';
import * as THREE from '../vendor/three/three.module.js';

const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('a mesh keeps its vertices, colours and its material roughness', () => {
    const m = {
        material: 'water',
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
        normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
        colors: new Float32Array([0.2, 0.3, 0.4, 0.2, 0.3, 0.4, 0.2, 0.3, 0.4]),
        indices: new Uint32Array([0, 1, 2]),
    };
    const obj = meshObject(m, { water: { roughness: 0.1 } });
    assert.equal(obj.geometry.getAttribute('position').count, 3);
    assert.equal(obj.geometry.index.count, 3);
    assert.equal(obj.material.vertexColors, true);
    near(obj.material.roughness, 0.1);
    assert.equal(meshObject({ ...m, material: 'nothing' }).material.roughness, 1);
});

test('the sky is the one in light.js and the sun shines from SUN', () => {
    const scene = new THREE.Scene();
    const { sky, sun } = skyAndSun(scene);
    near(sky.topColor.r, SKY_COLOUR[0]);
    assert.equal(scene.environment, sky);
    const dir = sun.position.clone().sub(sun.target.position).normalize();
    near(dir.x, SUN[0]); near(dir.y, SUN[1]); near(dir.z, SUN[2]);
    assert.ok(sun.intensity > 2, 'π × SUN_STRENGTH');
});

test('a three camera has the basis transforms.json records', () => {
    const cams = cameraSet('z16-v1', { centre: [3, -2, 5], extent: 200 });
    for (const cam of [cams[0], cams[30], cams[55]]) {
        const c = cameraOf(cam);
        const e = c.matrixWorld.elements;          // column-major
        const w = cameraToWorld(cam);              // rows
        for (let r = 0; r < 3; r++) {
            for (let k = 0; k < 4; k++) near(e[k * 4 + r], w[r][k], 1e-4);
        }
    }
});

test('a placed asset is turned exactly as glbmesh.js turns its triangles', () => {
    const frame = tileFrame(16, 34231, 22946, 600);
    // instance.h is a height above the ellipsoid, as assemble reads it; the
    // tile's origin sits at frame.h, so this stands 3 m above it.
    const inst = { lon: frame.lon + 0.0004, lat: frame.lat - 0.0002, h: 603,
        yaw: 0.7, pitch: 0.3, roll: -0.5, scale: 2 };
    const obj = placeObject(new THREE.Object3D(), poseOf(inst, frame));
    const b = basisOf(inst.yaw, inst.pitch, inst.roll, inst.scale);
    const e = obj.matrixWorld.elements;
    const rows = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
    rows.forEach((v, i) => near(v, b[i], 1e-5));
    assert.ok(obj.position.x > 0 && obj.position.z > 0, 'east and south of the origin');
    near(obj.position.y, 3, 0.01);
});

test('floats become toned, top-down bytes', () => {
    const n = 2;
    const f = new Float32Array(n * n * 4);
    f.set([0.5, 0.5, 0.5, 1], 0);              // bottom-left in GL order
    f.set([1, 0, 0, 1], (n * (n - 1)) * 4);      // top-left
    const out = toBytes(f, n);
    assert.ok(out[0] >= 250, 'top-left row first');
    assert.equal(out[3], 255);
    // Mid grey through the ACES curve and sRGB: brighter than half, as the
    // rasteriser draws it (client/lib/raster.js).
    assert.ok(out[n * 4 * (n - 1)] > 140 && out[n * 4 * (n - 1)] < 200, `${out[n * 4 * (n - 1)]}`);
});
