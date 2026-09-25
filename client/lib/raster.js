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

// The grain on the ground: a tileable greyscale the terrain's colour is
// multiplied by, laid across the world every GRAIN_M metres by position, so
// it is the same grain on the same ground from every camera and across every
// tile's edge. Three octaves of value noise at 6 m, 1.5 m and 0.4 m, within
// a seventh of the colour. The header above said no texture on the ground,
// because a pattern reads as a pattern: this is the texture of ground with
// no pattern in it, and it is the difference between a hillside a trainer
// can hold a splat still on and one where every position along the slope
// reproduces the frame equally well. The vertex mottle (client/lib/terrain.js
// mottleAt) is the same idea at the mesh's own resolution; this is finer than
// any mesh. Deterministic: the same bytes every time (Invariant 2).
export const GRAIN_M = 24;
const GRAIN_PX = 512;
const GRAIN = [{ cells: 4, amp: 0.06 }, { cells: 16, amp: 0.05 }, { cells: 64, amp: 0.03 }];
let grain = null;

function hashAt(i, j) {
    let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Value noise on a lattice of `cells` across the texture, wrapping, so the
// texture tiles.
function tileNoise(u, v, cells) {
    const x = u * cells; const y = v * cells;
    const i = Math.floor(x); const j = Math.floor(y);
    const fade = (t) => t * t * (3 - 2 * t);
    const su = fade(x - i); const sv = fade(y - j);
    const at = (a, b) => hashAt(((a % cells) + cells) % cells, ((b % cells) + cells) % cells);
    const top = at(i, j) * (1 - su) + at(i + 1, j) * su;
    const bottom = at(i, j + 1) * (1 - su) + at(i + 1, j + 1) * su;
    return top * (1 - sv) + bottom * sv;
}

export function grainAt(u, v) {
    let m = 1;
    for (const { cells, amp } of GRAIN) m += (tileNoise(u, v, cells) - 0.5) * 2 * amp;
    return m;
}

export function grainTexture() {
    if (grain) return grain;
    const n = GRAIN_PX;
    const data = new Uint8Array(n * n * 4);
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const k = Math.round(Math.min(grainAt((i + 0.5) / n, (j + 0.5) / n), 1) * 255);
            data.set([k, k, k, 255], (j * n + i) * 4);
        }
    }
    grain = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    grain.wrapS = THREE.RepeatWrapping;
    grain.wrapT = THREE.RepeatWrapping;
    grain.minFilter = THREE.LinearMipmapLinearFilter;
    grain.magFilter = THREE.LinearFilter;
    grain.generateMipmaps = true;
    grain.colorSpace = THREE.NoColorSpace;
    grain.needsUpdate = true;
    return grain;
}

// The ground's texture coordinates: its position, in grains.
export function groundUv(positions) {
    const uv = new Float32Array(positions.length / 3 * 2);
    for (let i = 0, k = 0; i < positions.length; i += 3, k += 2) {
        uv[k] = positions[i] / GRAIN_M;
        uv[k + 1] = positions[i + 2] / GRAIN_M;
    }
    return uv;
}

// One mesh of the assembled scene (client/lib/mesh.js unpacked) as three.js
// geometry: its vertex colours and its material's roughness; the ground
// with its grain.
export function meshObject(m, materials = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    const ground = m.material === 'terrain';
    if (ground) g.setAttribute('uv', new THREE.BufferAttribute(groundUv(m.positions), 2));
    const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, metalness: 0,
        roughness: materials[m.material]?.roughness ?? 1,
        map: ground ? grainTexture() : null,
        // Both faces, in the colour pass: a slope folded by a nodata spike or
        // a steep DEM cell, seen from a low ring camera, is otherwise culled
        // to a white streak the trainer then learns as a hole (dataset-v2).
        // The shadow pass keeps drawing back faces only, as below.
        side: THREE.DoubleSide,
        shadowSide: THREE.BackSide,
        // The shadow pass draws back faces (three.js's default), and that is
        // right for a heightfield: the map holds the far slopes, a valley
        // behind a hill is deeper than the hill's far slope and is shadowed,
        // a sunlit slope has nothing nearer in front of it and is lit. frame-v6
        // drew both sides into it, so every sunlit point compared its depth
        // against its own and self-shadowed wherever the depth rounded the
        // wrong way. It was not the side: a heightfield's back face is the
        // same surface. Nor the bias (v8). It was the shadow map's own depth
        // precision (v9, the constructor).
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

// A pose from client/lib/cameras.js as a three.js camera. lookAt builds the
// same basis cameraToWorld() writes into transforms.json: back = eye - target,
// right = up × back, up = back × right. The path tracer uses it too.
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
        // Transparent where nothing is drawn: a tile is an island, and every
        // oblique view sees past its edge. What is there is not sky — it is
        // the absence of a tile — and a frame that paints it sky teaches the
        // trainer a sky-coloured wall at the edge of every tile. The alpha
        // goes into the WebP, and brush is told to read it as a mask
        // (client/lib/brush.js configFor, alpha-mode masked): those pixels
        // are not the trainer's business.
        const r = new THREE.WebGLRenderer({
            canvas, antialias: true, alpha: true, premultipliedAlpha: false,
            preserveDrawingBuffer: true,
        });
        r.setClearColor(0x000000, 0);
        r.setSize(size, size, false);
        // PCF, not VSM. Variance shadow maps store their depth moments as
        // half floats (WebGLShadowMap: RGFormat, HalfFloatType): a 10-bit
        // mantissa over a shadow camera kilometres deep is a depth step of a
        // metre or two, the ground's true depth crosses it continuously along
        // the sun, and step(z, mean) flips at every stair — regular stripes
        // across flat ground, in every frame from v4 to v8, which no bias and
        // no cast side could touch. PCF compares against a 24-bit depth
        // texture: a third of a millimetre over the same range.
        r.shadowMap.enabled = shadows;
        r.shadowMap.type = THREE.PCFSoftShadowMap;
        r.toneMapping = THREE.ACESFilmicToneMapping;
        r.toneMappingExposure = 1.0;
        r.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer = r;
        this.scene = new THREE.Scene();
        const sky = skyTexture();
        this.scene.environment = new THREE.PMREMGenerator(r).fromEquirectangular(sky).texture;
        this.scene.background = null;
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
        // The sun sits 2r from the centre; the scene is within r of it.
        sc.near = radius * 0.9; sc.far = radius * 3.1;
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
