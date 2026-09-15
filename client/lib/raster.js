// raster.js — the frame atom's renderer: three.js, rasterised.
//
// frame-v2 and v3 path-traced the assembled scene at a few dozen paths a
// pixel. Seconds a frame on a good card, minutes on a Quadro, and the result
// still needed a denoiser. A rasteriser with the lighting a modern engine
// carries — soft shadow maps from the sun, the sky as an environment map,
// filmic tone mapping, a detail texture on the ground — is a few milliseconds
// a frame and a cleaner picture. The sun and the sky are client/lib/light.js's,
// so a frame and a sampled tile are lit by the same numbers.
//
// It runs on an OffscreenCanvas inside a Web Worker. The vendored modules are
// what runs (tools/vendor.sh vendor_three); there is no CDN copy of these.

import * as THREE from '../vendor/three/three.module.js';
import { GLTFLoader } from '../vendor/three/GLTFLoader.js';
import { BOUNCE_COLOUR, SKY_COLOUR, SUN, SUN_COLOUR, SUN_STRENGTH } from './light.js';
import { localFromLonLat } from './tilemath.js';

export const SHADOW_MAP = 4096;
export const DETAIL_M = 6;          // metres a detail tile repeats over

// A tileable value-noise texture, gray around 0.9: the ground's colour is
// one number per vertex and this is the grain between vertices. Seeded, so
// two workers draw the same grain (Invariant 2).
export function detailTexture(size = 256, seed = 7) {
    let s = seed;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const cells = 16;
    const lattice = new Float32Array(cells * cells);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
    const at = (i, j) => lattice[((j + cells) % cells) * cells + ((i + cells) % cells)];
    const smooth = (t) => t * t * (3 - 2 * t);
    const noise = (u, v) => {
        const i = Math.floor(u); const j = Math.floor(v);
        const fu = smooth(u - i); const fv = smooth(v - j);
        return (at(i, j) * (1 - fu) + at(i + 1, j) * fu) * (1 - fv)
            + (at(i, j + 1) * (1 - fu) + at(i + 1, j + 1) * fu) * fv;
    };
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = x / size * cells; const v = y / size * cells;
            const f = 0.5 * noise(u, v) + 0.3 * noise(u * 2, v * 2) + 0.2 * noise(u * 4, v * 4);
            const g = Math.round((0.72 + 0.36 * f) * 255);
            data.set([g, g, g, 255], (y * size + x) * 4);
        }
    }
    const tex = new THREE.DataTexture(data, size, size);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
}

// One mesh of the assembled scene (client/lib/mesh.js unpacked) as three.js
// geometry: its vertex colours, its material's roughness, and on the ground
// the detail texture over world x/z.
export function meshObject(m, materials = {}, detail = null) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, metalness: 0,
        roughness: materials[m.material]?.roughness ?? 1,
        // The shadow pass draws back faces unless told otherwise, and the
        // ground has none facing the sun: a hill cast no shadow on its valley.
        shadowSide: THREE.DoubleSide,
    });
    if (detail && (m.material === 'terrain' || m.material === 'road')) {
        const uv = new Float32Array(m.positions.length / 3 * 2);
        for (let i = 0; i < uv.length / 2; i++) {
            uv[i * 2] = m.positions[i * 3] / DETAIL_M;
            uv[i * 2 + 1] = m.positions[i * 3 + 2] / DETAIL_M;
        }
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        mat.map = detail;
        mat.bumpMap = detail;
        mat.bumpScale = 0.35;
    }
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
    obj.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        for (const m of [].concat(o.material)) m.shadowSide = THREE.DoubleSide;
    });
    obj.updateMatrixWorld(true);
    return obj;
}

// readPixels counts rows from the bottom; a frame is top-down.
export function flip(bytes, n) {
    const out = new Uint8ClampedArray(bytes.length);
    const row = n * 4;
    for (let y = 0; y < n; y++) out.set(bytes.subarray((n - 1 - y) * row, (n - y) * row), y * row);
    return out;
}

export class Raster {
    constructor(canvas, size) {
        this.size = size;
        const r = new THREE.WebGLRenderer({
            canvas, antialias: true, alpha: false, preserveDrawingBuffer: true,
        });
        r.setSize(size, size, false);
        r.shadowMap.enabled = true;
        r.shadowMap.type = THREE.PCFShadowMap;
        r.toneMapping = THREE.ACESFilmicToneMapping;
        r.toneMappingExposure = 1.1;
        r.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer = r;
        this.scene = new THREE.Scene();
        this.detail = detailTexture();
        const sky = skyTexture();
        this.scene.environment = new THREE.PMREMGenerator(r).fromEquirectangular(sky).texture;
        this.scene.background = new THREE.Color(...SKY_COLOUR);
        // A Lambertian surface under a directional light of intensity I
        // reflects albedo × I × cos / π, so π × SUN_STRENGTH matches lightAt().
        this.sun = new THREE.DirectionalLight(new THREE.Color(...SUN_COLOUR),
            Math.PI * SUN_STRENGTH);
        this.sun.castShadow = true;
        this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
        this.sun.shadow.bias = -0.0004;
        this.sun.shadow.normalBias = 0.6;
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
        this.detail.dispose();
        this.renderer.dispose();
    }
}
