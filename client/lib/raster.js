// raster.js — the frame atom's renderer: three.js, drawing what assemble baked.
//
// frame-v2 and v3 path-traced the assembled scene; v4 rasterised it with
// shadow maps, an environment map, filmic tone mapping and a detail texture.
// Each was a fourth idea of what the world looks like, next to the sampled
// splats' and the ground mesh's, and the three met at every tile edge as a
// seam. Since assemble-v3 the light is baked into the vertices once
// (client/lib/light.js shade, client/lib/terrain.js sunlitAt) and this draws
// those colours as they are: no lights, no tone curve, no texture. A frame is
// the mesh, the sampled tile is the mesh, the ground is the mesh.
//
// It runs on an OffscreenCanvas inside a Web Worker. The vendored modules are
// what runs (tools/vendor.sh vendor_three); there is no CDN copy of these.

import * as THREE from '../vendor/three/three.module.js';
import { SKY_COLOUR } from './light.js';

// One mesh of the assembled scene (client/lib/mesh.js unpacked) as three.js
// geometry, coloured by its vertices and nothing else.
export function meshObject(m) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true }));
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
    constructor(canvas, size) {
        this.size = size;
        const r = new THREE.WebGLRenderer({
            canvas, antialias: true, alpha: false, preserveDrawingBuffer: true,
        });
        r.setSize(size, size, false);
        // The vertex colours are already what the screen shows (light.js
        // tone): they go to the frame untouched, as they go into a .sog.
        r.toneMapping = THREE.NoToneMapping;
        r.outputColorSpace = THREE.LinearSRGBColorSpace;
        this.renderer = r;
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(...SKY_COLOUR);
        this.camera = null;
    }

    add(obj) { this.scene.add(obj); }

    // Once, after everything is in the scene: the shaders are compiled.
    async build(cam) {
        this.camera = cameraOf(cam);
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
