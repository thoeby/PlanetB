// groundmesh.js — the ground, everywhere the coverage reaches.
//
// A published tile is splats and carries its own height.r16; a tile nobody has
// rendered yet carries nothing, and until now the viewer had no floor there at
// all — player.js's Terrain only knows tiles the streamer has loaded, so on a
// fresh world you spawned two metres above sea level with the Alps somewhere
// underneath you (SPEC §0.1: "Ground is always drawn and always walkable,
// whether or not anything has been rendered there").
//
// So: the same /geo/dem/{z}/{x}/{y}.r16 tiles the compile reads, streamed
// around the player, drawn as a mesh and sampled for height. Published splats
// sit on top of this; it is never what a compile reads back.

import { loadDem, sampleHeight } from './geo.js';
import * as tm from './tilemath.js';
import { terrainColour } from './terrain.js';

// One z14 tile is about 1.7 km on the ground at Alpine latitudes, so a radius
// of one is a five-kilometre floor: further than a walk and fewer than ten
// requests. The grid is coarser than a compiled tile's (129) because this is
// the floor under everything, not the thing being looked at.
export const GROUND_Z = 14;
export const GROUND_GRID = 65;

const key = (z, x, y) => `${z}/${x}/${y}`;

// The same fixed sun lib/render.js bakes into every compiled frame, and the
// same floor under it. The ground a player walks on and the ground a compile
// renders are then the same picture, which is what makes an unrendered tile
// and a published one read as one world.
const SUN = [0.42, 0.83, 0.36];
const SUN_LEN = Math.hypot(...SUN);
const shade = (n) => {
    const d = Math.max((n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2]) / SUN_LEN, 0);
    return 0.55 + 0.55 * d;
};

// The surface normal at one grid point, from its neighbours' own positions:
// the grid is not flat in the local frame, so the heights alone do not say it.
function normalAt(p, grid, i, j) {
    const at = (ii, jj) => {
        const k = (Math.min(Math.max(jj, 0), grid - 1) * grid
            + Math.min(Math.max(ii, 0), grid - 1)) * 3;
        return [p[k], p[k + 1], p[k + 2]];
    };
    const a = at(i + 1, j);
    const b = at(i - 1, j);
    const c = at(i, j + 1);
    const d = at(i, j - 1);
    const du = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const dv = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
    const n = [dv[1] * du[2] - dv[2] * du[1], dv[2] * du[0] - dv[0] * du[2],
        dv[0] * du[1] - dv[1] * du[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / len, n[1] / len, n[2] / len];
}

// Where (lon, lat) falls inside its tile, 0..1 from the north-west corner.
// Web-Mercator rows are not linear in latitude, so v comes from the same
// arithmetic tileY() rounds down.
function inTile(z, x, y, lon, lat) {
    const n = 2 ** z;
    const phi = Math.max(-tm.MAX_LAT, Math.min(tm.MAX_LAT, lat)) * tm.RAD_PER_DEG;
    return {
        u: (lon + 180) / 360 * n - x,
        v: (1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * n - y,
    };
}

// The inverse, for laying the grid out: row v of tile y, as a latitude.
const latOf = (z, y, v) =>
    Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + v) / 2 ** z))) / tm.RAD_PER_DEG;

// One tile's worth of ground: the samples, and the mesh they make in the
// anchor's frame. `localOf` is the floating origin's own (js/origin.js), so
// the vertices land in the same frame as everything else in the scene and a
// rebase is a rebuild from the geodetic originals.
//
// Kept apart from the drawing so it can be tested without a graphics device.
export function groundTile(z, x, y, dem, localOf, grid = GROUND_GRID) {
    const b = tm.tileBbox(z, x, y);
    const h = new Float64Array(grid * grid);
    const positions = [];
    const colors = [];
    const indices = [];
    for (let j = 0; j < grid; j++) {
        const lat = latOf(z, y, j / (grid - 1));
        for (let i = 0; i < grid; i++) {
            const lon = b.west + (b.east - b.west) * (i / (grid - 1));
            const metres = sampleHeight(dem, i / (grid - 1), j / (grid - 1));
            h[j * grid + i] = metres;
            const p = localOf({ lon, lat, h: metres });
            positions.push(p.x, p.y, p.z);
        }
    }
    const normals = [];
    for (let j = 0; j < grid; j++) {
        for (let i = 0; i < grid; i++) {
            const n = normalAt(positions, grid, i, j);
            const lit = shade(n);
            normals.push(...n);
            for (const c of terrainColour(slopeAt(h, grid, i, j, b), h[j * grid + i])) {
                colors.push(Math.min(c * lit, 1));
            }
        }
    }
    for (let j = 0; j < grid - 1; j++) {
        for (let i = 0; i < grid - 1; i++) {
            const a = j * grid + i;
            indices.push(a, a + grid, a + 1, a + 1, a + grid, a + grid + 1);
        }
    }
    return { z, x, y, dem, grid, h, positions, normals, colors, indices, bbox: b };
}

// Rise over run, in metres per metre, for the colour: steep ground is rock.
// One grid step, east to west, at this tile's latitude.
function slopeAt(h, grid, i, j, b) {
    const mid = (b.south + b.north) / 2;
    const metres = Math.max((b.east - b.west) * tm.RAD_PER_DEG * 6378137
        * Math.cos(mid * tm.RAD_PER_DEG) / (grid - 1), 1);
    const l = h[j * grid + Math.max(i - 1, 0)];
    const r = h[j * grid + Math.min(i + 1, grid - 1)];
    const u = h[Math.max(j - 1, 0) * grid + i];
    const d = h[Math.min(j + 1, grid - 1) * grid + i];
    return Math.hypot((r - l) / (2 * metres), (d - u) / (2 * metres));
}

// Bilinear height inside one loaded tile, in metres.
export function heightIn(tile, lon, lat) {
    const { u, v } = inTile(tile.z, tile.x, tile.y, lon, lat);
    if (u < 0 || v < 0 || u > 1 || v > 1) return null;
    const g = tile.grid;
    const fu = Math.min(u * (g - 1), g - 1.0001);
    const fv = Math.min(v * (g - 1), g - 1.0001);
    const i = Math.floor(fu);
    const j = Math.floor(fv);
    const su = fu - i;
    const sv = fv - j;
    const a = tile.h[j * g + i];
    const bb = tile.h[j * g + i + 1];
    const c = tile.h[(j + 1) * g + i];
    const d = tile.h[(j + 1) * g + i + 1];
    return (a * (1 - su) + bb * su) * (1 - sv) + (c * (1 - su) + d * su) * sv;
}

export class Ground {
    constructor({ pc, app, origin, filesUrl, fetchFn = fetch,
        zoom = GROUND_Z, grid = GROUND_GRID, radius = 1 } = {}) {
        Object.assign(this, { pc, app, origin, filesUrl, fetchFn, zoom, grid, radius });
        this.localOf = (g) => origin.localOf(g);
        this.tiles = new Map();
        this.entities = new Map();
        this.pending = new Set();
        // A tile the coverage does not reach is a 404, and asking again every
        // frame is a request a second for ever.
        this.nothingThere = new Set();
        this.onSaid = null;
    }

    get count() { return this.tiles.size; }

    // The ground under a point, or null when the tile it is in has not
    // arrived. Callers fall back to a published tile's own height.r16.
    heightAt(lon, lat) {
        const k = key(this.zoom, tm.tileX(lon, this.zoom), tm.tileY(lat, this.zoom));
        const tile = this.tiles.get(k);
        return tile ? heightIn(tile, lon, lat) : null;
    }

    // Load what is around here and drop what is not. Safe to call every frame:
    // everything it does is either already done or already in flight.
    follow(lon, lat) {
        const z = this.zoom;
        const cx = tm.tileX(lon, z);
        const cy = tm.tileY(lat, z);
        const want = new Set();
        for (let dy = -this.radius; dy <= this.radius; dy++) {
            for (let dx = -this.radius; dx <= this.radius; dx++) {
                want.add(key(z, cx + dx, cy + dy));
                this.load(z, cx + dx, cy + dy);
            }
        }
        for (const k of [...this.tiles.keys()]) if (!want.has(k)) this.drop(k);
        return this.tiles.size;
    }

    load(z, x, y) {
        const k = key(z, x, y);
        if (this.tiles.has(k) || this.pending.has(k) || this.nothingThere.has(k)) return;
        this.pending.add(k);
        loadDem(z, x, y, { filesUrl: this.filesUrl, fetchFn: this.fetchFn })
            .then((dem) => {
                this.pending.delete(k);
                // Outside the coverage there is no ground, which is not a
                // failure — it is the edge of the world (SPEC §3.8).
                if (!dem) { this.nothingThere.add(k); return; }
                const tile = groundTile(z, x, y, dem, this.localOf, this.grid);
                this.tiles.set(k, tile);
                this.draw(tile);
            })
            .catch((err) => {
                this.pending.delete(k);
                this.nothingThere.add(k);
                // SPEC §3.12: a tile that could not be cut says so, in words,
                // where the player is — never only in the console.
                this.onSaid?.(`no ground at ${k}: ${err.message ?? err}`);
            });
    }

    draw(tile) {
        if (!this.pc || !this.app) return null;
        const { pc } = this;
        const mesh = new pc.Mesh(this.app.graphicsDevice);
        mesh.setPositions(tile.positions);
        mesh.setNormals(tile.normals);
        mesh.setColors(tile.colors, 3);
        mesh.setIndices(tile.indices);
        mesh.update(pc.PRIMITIVE_TRIANGLES);
        // Nothing in this scene is lit — splats carry their own light and the
        // colour here is already the ground's (terrain.js terrainColour), so
        // the ground is drawn as it is rather than as a lamp finds it. The
        // vertex colour multiplies `emissive`, which is black by default: an
        // unlit material with nothing said about emissive draws nothing, which
        // is a black screen with a perfectly good mesh in it.
        const material = new pc.StandardMaterial();
        material.useLighting = false;
        material.diffuse = new pc.Color(0, 0, 0);
        material.emissive = new pc.Color(1, 1, 1);
        material.emissiveVertexColor = true;
        material.update();
        const entity = new pc.Entity(`ground:${key(tile.z, tile.x, tile.y)}`);
        entity.addComponent('render',
            { meshInstances: [new pc.MeshInstance(mesh, material)], castShadows: false });
        this.app.root.addChild(entity);
        this.entities.set(key(tile.z, tile.x, tile.y), entity);
        return entity;
    }

    drop(k) {
        this.tiles.delete(k);
        const entity = this.entities.get(k);
        if (entity) { entity.destroy(); this.entities.delete(k); }
    }

    // The anchor moved, so every vertex is in the wrong frame: the tiles are
    // rebuilt from the samples they already hold, with no refetching.
    rebase(origin) {
        this.origin = origin;
        this.localOf = (g) => origin.localOf(g);
        for (const [k, tile] of [...this.tiles]) {
            this.drop(k);
            const rebuilt = groundTile(tile.z, tile.x, tile.y, tile.dem,
                this.localOf, this.grid);
            this.tiles.set(k, rebuilt);
            this.draw(rebuilt);
        }
    }

    clear() { for (const k of [...this.tiles.keys()]) this.drop(k); }
}
