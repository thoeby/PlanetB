// raster.js — the frame atom's renderer: three.js, rasterised.
//
// frame-v2 and v3 path-traced the assembled scene at a few dozen paths a
// pixel. Seconds a frame on a good card, minutes on a Quadro, and the result
// still needed a denoiser. A rasteriser with the lighting a modern engine
// carries — soft shadow maps from the sun, the sky as an environment map,
// filmic tone mapping — is a few milliseconds a frame and a cleaner picture.
// This is the world's one renderer: every tile from z14 down is trained from
// what it draws (db/0104_thewholeground.sql), so there is no second look for
// it to disagree with. No texture on the ground: the survey is half a metre
// and its relief is the detail; a pattern laid over it reads as a pattern.
//
// It runs on an OffscreenCanvas inside a Web Worker. The vendored modules are
// what runs (tools/vendor.sh vendor_three); there is no CDN copy of these.

import * as THREE from '../vendor/three/three.module.js';
import { BOUNCE_COLOUR, SKY_COLOUR, SUN, SUN_COLOUR, SUN_STRENGTH } from './light.js';

export const SHADOW_MAP = 4096;

// One mesh of the assembled scene (client/lib/mesh.js unpacked) as three.js
// geometry: its vertex colours and its material's roughness.
export function meshObject(m, materials = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, metalness: 0,
        roughness: materials[m.material]?.roughness ?? 1,
        // The shadow pass draws back faces (three.js's default), and that is
        // right for a heightfield: the map holds the far slopes, a valley
        // behind a hill is deeper than the hill's far slope and is shadowed,
        // a sunlit slope has nothing nearer in front of it and is lit. frame-v6
        // drew both sides into it, so every sunlit point compared its depth
        // against its own and self-shadowed wherever the depth rounded the
        // wrong way. It was not the side: a heightfield's back face is the
        // same surface. frame-v8's normal bias (build) is what ended it.
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

// The one sky (client/lib/light.js) as an equirectangular radiance map, blue
// above and the ground's warmth below: an up-facing surface under a uniform
// sky of radiance L reflects albedo × L, which is lightAt()'s sky term.
export function skyTexture() {
    const w = 64; const h = 32;
    const data = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        const t = y / (h - 1);              // 0 at the top row = zenith
        for (let x = 0; x < w; x++) {
            const at = (y * w + x) * 4;
            for (let c = 0; c < 3; c++) {
                data[at + c] = SKY_COLOUR[c] * (1 - t) + BOUNCE_COLOUR[c] * t;
            }
            data[at + 3] = 1;
        }
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    return tex;
}

// A pose from client/lib/cameras.js as a three.js camera: lookAt builds the
// basis cameraToWorld() writes into transforms.json.
export function cameraOf(cam, { near = 0.5, far = 20000 } = {}) {
    const c = new THREE.PerspectiveCamera(cam.fov, 1, near, far);
    c.up.set(...cam.up);
    c.position.set(...cam.position);
    c.lookAt(...cam.target);
    c.updateMatrixWorld(true);
    return c;
}

// readPixels counts rows from the bottom; a frame is top-down.
export function flip(bytes, n) {
    const out = new Uint8ClampedArray(bytes.length);
    const row = n * 4;
    for (let y = 0; y < n; y++) out.set(bytes.subarray((n - 1 - y) * row, (n - y) * row), y * row);
    return out;
}

export class Raster {
    // `shadows: false` draws the sun without a shadow map at all: flat-lit
    // frames, for telling a stripe that is the shadow map's from one that is
    // the ground's (db/0119: `splatworld.shadows = 'off'`).
    constructor(canvas, size, { shadows = true } = {}) {
        this.size = size;
        const r = new THREE.WebGLRenderer({
            canvas, antialias: true, alpha: false, preserveDrawingBuffer: true,
        });
        r.setSize(size, size, false);
        // Variance shadow maps blur: the sun is a disc, not a point, and a
        // ridge's shadow on the valley has a soft edge.
        r.shadowMap.enabled = shadows;
        r.shadowMap.type = THREE.VSMShadowMap;
        r.toneMapping = THREE.ACESFilmicToneMapping;
        r.toneMappingExposure = 1.0;
        r.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer = r;
        this.scene = new THREE.Scene();
        const sky = skyTexture();
        this.scene.environment = new THREE.PMREMGenerator(r).fromEquirectangular(sky).texture;
        this.scene.background = new THREE.Color(...SKY_COLOUR);
        // A Lambertian surface under a directional light of intensity I
        // reflects albedo × I × cos / π, so π × SUN_STRENGTH matches lightAt().
        this.sun = new THREE.DirectionalLight(new THREE.Color(...SUN_COLOUR),
            Math.PI * SUN_STRENGTH);
        this.sun.castShadow = shadows;
        this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
        // No depth bias: a negative one pushes the comparison into the
        // surface, which is the acne. The normal bias set in build() is what
        // keeps a surface from shadowing itself.
        this.sun.shadow.bias = 0;
        this.sun.shadow.radius = 6;
        this.sun.shadow.blurSamples = 12;
        this.scene.add(this.sun, this.sun.target);
        this.camera = null;
    }

    add(obj) { this.scene.add(obj); }

    // Once, after everything is in the scene: the sun's shadow box is fitted
    // to what there is, and the shaders are compiled.
    async build(cam) {
        this.camera = cameraOf(cam);
        // The meshes' box, not the scene's: the sun sits far outside it.
        const box = new THREE.Box3();
        this.scene.traverse((o) => { if (o.isMesh) box.expandByObject(o); });
        const centre = box.getCenter(new THREE.Vector3());
        const radius = box.getSize(new THREE.Vector3()).length() / 2 || 100;
        this.sun.position.set(centre.x + SUN[0] * radius * 2, centre.y + SUN[1] * radius * 2,
            centre.z + SUN[2] * radius * 2);
        this.sun.target.position.copy(centre);
        const sc = this.sun.shadow.camera;
        sc.left = -radius; sc.right = radius; sc.top = radius; sc.bottom = -radius;
        sc.near = 0.5; sc.far = radius * 4;
        sc.updateProjectionMatrix();
        // The ground is one surface: whichever side the shadow pass draws, it
        // is the same triangles at the same depth, and every point of it
        // compares against itself. Rounding decides, and rounding is the
        // map's texel grid laid across every frame as fine diagonal stripes
        // (frame-v6, v7). The lookup is moved off the surface along its
        // normal by a texel and a half, so a surface never finds itself.
        this.sun.shadow.normalBias = (2 * radius / SHADOW_MAP) * 1.5;
        this.sun.target.updateMatrixWorld(true);
        await this.renderer.compileAsync(this.scene, this.camera);
    }

    // RGBA bytes, top-down, of one pose.
    draw(cam) {
        const c = this.camera;
        c.position.set(...cam.position);
        c.up.set(...cam.up);
        c.lookAt(...cam.target);
        c.updateMatrixWorld(true);
        this.renderer.render(this.scene, c);
        const n = this.size;
        const gl = this.renderer.getContext();
        const bytes = new Uint8Array(n * n * 4);
        gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        return flip(bytes, n);
    }

    dispose() {
        this.renderer.dispose();
    }
}
