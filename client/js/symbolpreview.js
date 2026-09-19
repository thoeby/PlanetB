// symbolpreview.js — the symbol, on a sample.
//
// FND.7. A stack of layers is unreadable until something is built with it, so
// the editor builds one: a 60 m S-curve for a line symbol, a 40 × 30 m polygon
// for an area, a point for a point, on a gentle slope, compiled in this tab by
// the same `client/lib/gen/` the atom runs. What the preview shows is what the
// tile will have in it.
//
// Drawn with client/lib/render.js — the renderer the tile's own frames are
// traced with — rather than the engine, so the panel costs one WebGL context
// and the shading is the world's.

import { Terrain, terrainMesh } from '../lib/terrain.js';
import { context, runAll } from '../lib/gen/index.js';
import { rng } from '../lib/poly.js';
import { Renderer } from '../lib/render.js';

const SIZE = 256;

// lib/mesh.js accumulates plain arrays and lib/mesh.js's packMeshes turns them
// into buffers; the renderer wants the buffers.
const typed = (m) => ({
    positions: Float32Array.from(m.positions),
    normals: Float32Array.from(m.normals),
    colors: Float32Array.from(m.colors),
    indices: Uint32Array.from(m.indices),
});
const HALF = 40;                                   // metres either way

// A gentle slope, so a surface laid on it and a scatter refused by it both
// show. dem-v1 counts: elevation_m = value * 0.2 - 500.
function sampleGround() {
    const n = 33;
    const data = new Uint16Array(n * n);
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            data[j * n + i] = Math.round((500 + i * 0.35 + 3 * Math.sin(j / 5)) / 0.2);
        }
    }
    return { size: n, data, u0: 0, v0: 0, span: 1 };
}

// An S-curve 60 m long, a rectangle 40 × 30 m, and a point in the middle —
// one sample per geometry, so a symbol is tried on the shape it is about.
export function sampleFeature(kind, geometry, props = {}) {
    const base = { id: 'sample', kind, props, rings: [], lines: [], points: [] };
    if (geometry === 'line') {
        return { ...base, lines: [[[-30, -14], [-10, 6], [10, -6], [30, 14]]],
            contains: () => false };
    }
    if (geometry === 'point') {
        return { ...base, points: [[0, 0]], contains: () => false };
    }
    const ring = [[-20, -15], [20, -15], [20, 15], [-20, 15]];
    return { ...base, rings: [ring],
        contains: (x, z) => x >= -20 && x <= 20 && z >= -15 && z <= 15 };
}

// Where the eye is: `spin` and `tilt` come from dragging on the canvas.
const camera = (spin, tilt) => {
    const r = 70;
    const y = Math.max(6, r * Math.sin(tilt));
    return { position: [Math.sin(spin) * r * Math.cos(tilt), y,
        Math.cos(spin) * r * Math.cos(tilt)],
    target: [0, 4, 0], up: [0, 1, 0], fov: 40, near: 1, far: 400 };
};

export class SymbolPreview {
    constructor(make = (w, h) => new OffscreenCanvas(w, h)) {
        this.make = make;
        this.renderer = null;
        this.spin = 0.7;
        this.tilt = 0.5;
        this.count = 0;
    }

    // What the layers built, as meshes, without drawing anything: the story
    // asks how many pieces a `repeat` put down.
    compile(symbol, feature, { asset = () => null } = {}) {
        const terrain = new Terrain({ sw: { x: -HALF, z: HALF }, ne: { x: HALF, z: -HALF },
            size: 65, dem: sampleGround() });
        const mid = terrain.at(0, 0);
        for (let i = 0; i < terrain.h.length; i++) terrain.h[i] -= mid;
        const ctx = context({ terrain, random: rng(7), radius: 6, asset,
            cut: () => {} });
        const drawn = runAll([symbol], [feature], ctx);
        this.count = drawn.meshes.length;
        return { meshes: [terrainMesh(terrain, 'terrain'), ...drawn.meshes],
            flags: drawn.flags, trees: ctx.trees };
    }

    draw(canvas, symbol, feature, opts = {}) {
        const built = this.compile(symbol, feature, opts);
        this.renderer?.dispose();
        this.renderer = new Renderer(this.make(SIZE, SIZE), SIZE);
        this.renderer.upload(built.meshes.filter((m) => m.indices.length).map(typed));
        const cam = camera(this.spin, this.tilt);
        const rgba = this.renderer.draw(cam, { near: cam.near, far: cam.far });
        const tmp = this.make(SIZE, SIZE);
        tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba),
            SIZE, SIZE), 0, 0);
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
        return built;
    }

    // Dragging on the picture turns it, the way every 3D view in this world
    // turns.
    orbit(dx, dy) {
        this.spin -= dx * 0.01;
        this.tilt = Math.max(0.1, Math.min(1.4, this.tilt + dy * 0.005));
    }
}
