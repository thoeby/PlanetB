// pathtrace.js — the frame atom's renderer: three.js and three-gpu-pathtracer.
//
// frame-v1 drew the assembled scene with a forward shader — vertex colours, one
// sun, no shadows, no textures — and a splat can never look better than the
// frames it is trained on. This traces paths instead: the same sun and the same
// sky as client/lib/light.js, but now a house shades the ground, a valley wall
// shades the valley, and a placed asset shows the textures its author gave it,
// because the canonical GLB is loaded whole rather than flattened to a colour.
//
// It runs on an OffscreenCanvas inside a Web Worker. The vendored modules are
// what runs (tools/vendor.sh vendor_three); there is no CDN copy of these.

import * as THREE from '../vendor/three/three.module.js';
import { GLTFLoader } from '../vendor/three/GLTFLoader.js';
import { GradientEquirectTexture, WebGLPathTracer } from '../vendor/three/three-gpu-pathtracer.js';
import { BOUNCE_COLOUR, SKY_COLOUR, SUN, SUN_COLOUR, SUN_STRENGTH, tone } from './light.js';
import { localFromLonLat } from './tilemath.js';

export const DEFAULTS = { samples: 64, bounces: 3 };

// One mesh of the assembled scene (client/lib/mesh.js unpacked), as three.js
// geometry with its vertex colours and its material's roughness.
export function meshObject(m, materials = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, metalness: 0,
        roughness: materials[m.material]?.roughness ?? 1,
    });
    return new THREE.Mesh(g, mat);
}

// The one sky (client/lib/light.js), as the path tracer sees it. An up-facing
// surface under a uniform sky of radiance L reflects albedo × L, so the
// gradient's top is SKY_COLOUR and its bottom BOUNCE_COLOUR as they stand. A
// Lambertian surface under a directional light of intensity I reflects
// albedo × I × cos / π, so the sun's intensity is π × SUN_STRENGTH to match
// lightAt()'s SUN_COLOUR × SUN_STRENGTH × cos.
export function skyAndSun(scene) {
    const sky = new GradientEquirectTexture();
    sky.topColor.setRGB(...SKY_COLOUR);
    sky.bottomColor.setRGB(...BOUNCE_COLOUR);
    sky.exponent = 1;
    sky.update();
    scene.environment = sky;
    scene.background = sky;
    const sun = new THREE.DirectionalLight(new THREE.Color(...SUN_COLOUR), Math.PI * SUN_STRENGTH);
    sun.position.set(SUN[0] * 1000, SUN[1] * 1000, SUN[2] * 1000);
    sun.target.position.set(0, 0, 0);
    scene.add(sun, sun.target);
    return { sky, sun };
}

// A pose from client/lib/cameras.js as a three.js camera. lookAt builds the
// same basis cameraToWorld() writes into transforms.json: back = eye - target,
// right = up × back, up = back × right.
export function cameraOf(cam, { near = 0.5, far = 20000 } = {}) {
    const c = new THREE.PerspectiveCamera(cam.fov, 1, near, far);
    c.up.set(...cam.up);
    c.position.set(...cam.position);
    c.lookAt(...cam.target);
    c.updateMatrixWorld(true);
    return c;
}

// Where an instance stands in the tile's own frame, and how it is turned:
// glbmesh.js's basisOf(yaw, pitch, roll) is exactly three's Euler order YXZ.
export function poseOf(inst, frame) {
    const p = localFromLonLat(frame, inst.lon, inst.lat, inst.h ?? 0);
    return {
        position: [p.x, p.y, p.z],
        euler: [inst.pitch ?? 0, inst.yaw ?? 0, inst.roll ?? 0],
        scale: inst.scale ?? 1,
    };
}

// A canonical GLB's scene, loaded whole with its textures. GLTFLoader decodes
// images with createImageBitmap, which a Worker has.
export function loadGlb(bytes) {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Promise((resolve, reject) => {
        new GLTFLoader().parse(buf, '', (gltf) => resolve(gltf.scene), reject);
    });
}

export function placeObject(obj, pose) {
    obj.position.set(...pose.position);
    obj.rotation.set(pose.euler[0], pose.euler[1], pose.euler[2], 'YXZ');
    obj.scale.setScalar(pose.scale);
    obj.updateMatrixWorld(true);
    return obj;
}

// readRenderTargetPixels counts rows from the bottom and gives linear floats;
// a frame is top-down bytes, toned exactly as a sampled splat is
// (client/lib/light.js tone).
export function toBytes(float, n) {
    const out = new Uint8ClampedArray(n * n * 4);
    for (let y = 0; y < n; y++) {
        const src = (n - 1 - y) * n * 4;
        const dst = y * n * 4;
        for (let x = 0; x < n * 4; x += 4) {
            out[dst + x] = tone(float[src + x]) * 255;
            out[dst + x + 1] = tone(float[src + x + 1]) * 255;
            out[dst + x + 2] = tone(float[src + x + 2]) * 255;
            out[dst + x + 3] = 255;
        }
    }
    return out;
}

export class Tracer {
    constructor(canvas, size, { samples = DEFAULTS.samples, bounces = DEFAULTS.bounces } = {}) {
        this.size = size;
        this.samples = samples;
        this.renderer = new THREE.WebGLRenderer({
            canvas, antialias: false, alpha: false, preserveDrawingBuffer: false,
        });
        this.renderer.setSize(size, size, false);
        this.tracer = new WebGLPathTracer(this.renderer);
        const t = this.tracer;
        t.bounces = bounces;
        // A sample is traced a quarter of the frame at a time, and the worker
        // yields between quarters: the page shares this GPU, and sixty-four
        // whole frames back to back froze it (and every other tab).
        t.tiles.set(2, 2);
        t.minSamples = 1;
        // The library waits renderDelay ms after a reset before it traces —
        // an interactive courtesy; a frame atom has nothing to be courteous to.
        t.renderDelay = 0;
        t.fadeDuration = 0;
        t.renderToCanvas = false;
        t.dynamicLowRes = false;
        t.filterGlossyFactor = 0.5;
        t.multipleImportanceSampling = true;
        // The same seed on every machine: what noise is left is the same noise.
        t.stableNoise = true;
        this.scene = new THREE.Scene();
        skyAndSun(this.scene);
        this.camera = null;
    }

    add(obj) { this.scene.add(obj); }

    // Once, after everything is in the scene: the BVH is built here, and the
    // shader is compiled. The compile starts on the first sample and runs
    // asynchronously; every sample asked for before it resolves is silently
    // skipped, so one sample is spent to start it and then waited for.
    async build(cam) {
        this.camera = cameraOf(cam);
        this.tracer.setScene(this.scene, this.camera);
        this.tracer.renderSample();
        while (this.tracer.isCompiling) await new Promise((r) => setTimeout(r, 5));
        // The first sample after a compile is not the same as every later one
        // (the library's own state settles); one more is spent so that every
        // frame drawn after this is the same bytes on the same machine.
        this.tracer.reset();
        this.tracer.renderSample();
        this.tracer.reset();
    }

    // RGBA bytes, top-down, of one pose.
    async draw(cam) {
        const c = this.camera;
        c.position.set(...cam.position);
        c.up.set(...cam.up);
        c.lookAt(...cam.target);
        c.updateMatrixWorld(true);
        this.tracer.updateCamera();
        this.tracer.reset();
        while (this.tracer.samples < this.samples) {
            this.tracer.renderSample();
            await new Promise((r) => setTimeout(r, 0));
        }
        const n = this.size;
        const float = new Float32Array(n * n * 4);
        this.renderer.readRenderTargetPixels(this.tracer.target, 0, 0, n, n, float);
        return toBytes(float, n);
    }

    dispose() {
        this.tracer.dispose?.();
        this.renderer.dispose();
    }
}
