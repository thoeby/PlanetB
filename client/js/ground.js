// ground.js — the ground drawn where nothing is published yet.
//
// SPEC §0.1: ground is always drawn and always walkable, whether or not
// anything has been rendered there; a tile in state `ground` is "plain
// terrain, ground colour" (§0.2). The floor under the player's feet is
// client/js/floor.js (read, not drawn); this is the same z14 elevation, as a
// mesh, for every tile around the camera that no published tile covers. A
// published tile takes its place the moment its row says so.

import { inTile } from '../lib/demshade.js';
import { sampleHeight } from '../lib/geo.js';
import { terrainColour } from '../lib/terrain.js';
import * as tm from '../lib/tilemath.js';
import { key } from './traverse.js';

const Z = 14;
// Grid points across one tile: 65 is a 27 m cell at z14, coarse enough that a
// ring of tiles is a few hundred kilobytes of geometry.
const N = 65;
// Tiles drawn around the one the camera stands on, each way.
const RING = 3;
// The sun the ramp is lit by, baked into the vertex colours: the scene has no
// light of its own, and the splats carry their own.
const SUN = [-0.45, 0.8, -0.4];

// A published tile at this key, or any published tile above it, covers it.
export function covered(tiles, z, x, y) {
    for (let az = z; az >= tm.MIN_ZOOM; az -= 2) {
        const f = 2 ** (z - az);
        const row = tiles.get(key(az, Math.floor(x / f), Math.floor(y / f)));
        if (row && row.published_version > 0) return true;
    }
    return false;
}

// One tile's heights on an N×N grid, in its own frame (tile centre at 0 m),
// and their shaded colours. `dem` is the loaded raster for this tile.
export function tileGeometry(z, x, y, dem, n = N) {
    const b = tm.tileBbox(z, x, y);
    const frame = tm.tileFrame(z, x, y);
    const heights = new Float32Array(n * n);
    const positions = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) {
        const lat = b.north + (b.south - b.north) * j / (n - 1);
        for (let i = 0; i < n; i++) {
            const lon = b.west + (b.east - b.west) * i / (n - 1);
            const { u, v } = inTile(z, x, y, lon, lat);
            const h = sampleHeight(dem, u, v);
            const p = tm.localFromLonLat(frame, lon, lat, h);
            const k = j * n + i;
            heights[k] = h;
            positions.set([p.x, p.y, p.z], k * 3);
        }
    }
    const stepX = (positions[3] - positions[0]) || 1;
    const stepZ = (positions[n * 3 + 2] - positions[2]) || 1;
    const { normals, colors } = shade(heights, n, stepX, stepZ);
    return { positions, normals, colors, indices: gridIndices(n) };
}

function shade(h, n, stepX, stepZ) {
    const normals = new Float32Array(n * n * 3);
    const colors = new Float32Array(n * n * 3);
    const sun = Math.hypot(...SUN);
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const l = h[j * n + Math.max(i - 1, 0)];
            const r = h[j * n + Math.min(i + 1, n - 1)];
            const u = h[Math.max(j - 1, 0) * n + i];
            const d = h[Math.min(j + 1, n - 1) * n + i];
            const v = [-(r - l) / (2 * stepX), 1, -(d - u) / (2 * stepZ)];
            const len = Math.hypot(v[0], v[1], v[2]);
            const nx = v[0] / len, ny = v[1] / len, nz = v[2] / len;
            const k = j * n + i;
            normals.set([nx, ny, nz], k * 3);
            // The ramp's slope is a gradient, rise over run, as terrain.js has it.
            const slope = Math.hypot(v[0], v[2]);
            const lit = Math.max(0, (nx * SUN[0] + ny * SUN[1] + nz * SUN[2]) / sun);
            const c = terrainColour(slope, h[k]).map((q) => q * (0.35 + 0.65 * lit));
            colors.set(c, k * 3);
        }
    }
    return { normals, colors };
}

function gridIndices(n) {
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let o = 0;
    for (let j = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
            const a = j * n + i;
            idx.set([a, a + n, a + 1, a + 1, a + n, a + n + 1], o);
            o += 6;
        }
    }
    return idx;
}

// The tiles a camera at (x, y) on z14 should have ground under: a square
// ring, the nearest first.
export function ringAround(x, y, ring = RING) {
    const out = [];
    for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) out.push({ x: x + dx, y: y + dy });
    }
    return out.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
}

export class DemGround {
    constructor(app, pc, { origin, floor, tiles }) {
        this.app = app;
        this.pc = pc;
        this.origin = origin;
        this.floor = floor;         // DemFloor: the rasters, fetched once each
        this.tiles = tiles;         // the streamer's rows, by key
        this.entities = new Map();
        this.material = null;
    }

    // Called every frame with the camera's local position: adds the tiles
    // around it whose raster has arrived, drops the ones a publish covered
    // or the camera left behind. One mesh is built per call at most.
    update(cameraLocal) {
        const g = this.origin.geodeticOf(cameraLocal);
        const cx = tm.tileX(g.lon, Z);
        const cy = tm.tileY(g.lat, Z);
        const want = new Set();
        let built = false;
        for (const { x, y } of ringAround(cx, cy)) {
            const k = `${x}/${y}`;
            if (covered(this.tiles, Z, x, y)) continue;
            want.add(k);
            if (this.entities.has(k) || built) continue;
            const dem = this.floor.tiles.get(k);
            if (dem === undefined) { this.floor.request(k, x, y); continue; }
            if (dem === null) continue;
            this.add(k, x, y, dem);
            built = true;
        }
        for (const [k, e] of this.entities) {
            if (want.has(k)) continue;
            e.destroy();
            this.entities.delete(k);
        }
    }

    add(k, x, y, dem) {
        const { pc } = this;
        const geo = tileGeometry(Z, x, y, dem);
        const mesh = new pc.Mesh(this.app.graphicsDevice);
        mesh.setPositions(geo.positions);
        mesh.setNormals(geo.normals);
        mesh.setColors(geo.colors, 3);
        mesh.setIndices(geo.indices);
        mesh.update(pc.PRIMITIVE_TRIANGLES);
        const entity = new pc.Entity(`ground ${k}`);
        entity.addComponent('render', {
            meshInstances: [new pc.MeshInstance(mesh, this.materialOf())],
            castShadows: false,
            receiveShadows: false,
        });
        entity.frame = tm.tileFrame(Z, x, y);
        this.place(entity);
        this.app.root.addChild(entity);
        this.entities.set(k, entity);
    }

    materialOf() {
        if (this.material) return this.material;
        const { pc } = this;
        const m = new pc.StandardMaterial();
        m.useLighting = false;
        m.diffuse = new pc.Color(0, 0, 0);
        m.emissive = new pc.Color(1, 1, 1);
        m.emissiveVertexColor = true;
        m.update();
        this.material = m;
        return m;
    }

    // The tile's mesh is in its own ENU frame; the scene is in the anchor's.
    place(entity) {
        const p = this.origin.localOf(entity.frame);
        entity.setLocalPosition(p.x, p.y, p.z);
        const q = tm.matrixToQuaternion(tm.enuRotation(entity.frame, this.origin.anchor));
        entity.setLocalRotation(q[0], q[1], q[2], q[3]);
    }

    rebased() {
        for (const e of this.entities.values()) this.place(e);
    }
}
