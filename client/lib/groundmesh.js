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
//
// Three levels of it, not one. A ring of z14 tiles is five kilometres of floor,
// which is a walk — and standing on a mountain looking at five kilometres of
// world with nothing behind it is the horizon falling away. So the fine ring
// you walk on is drawn inside a ring of z12 and one of z10, each of them a hole
// with the finer one in it (client/lib/groundtile.js), and the far one reaches
// forty kilometres. Only the fine level is walked on: the coarse ones are a
// picture of where you are, not ground anybody stands on.

import { loadDem } from './geo.js';
import * as tm from './tilemath.js';
import { cellMetres, groundTile, heightIn } from './groundtile.js';

export { cellMetres, groundTile, heightIn } from './groundtile.js';

// Fine first. `radius` is how many tiles either side of the one you are on, so
// 1 is a three-by-three block: 5 km at z14, 10 km at z12, 40 km at z10.
//
// The grid coarsens with the level because the far ones are a silhouette. z14
// keeps 65 — it is the floor, and the compile's own terrain is 129.
// The grid is what says how much of the DEM is used. A cut tile is 256 samples
// across (server/splatworld/importer.py), so 65 threw away three quarters of
// the ground a player is standing on; 129 is what the compile's own terrain
// uses and is the same hillside with its shape in it.
export const GROUND_LEVELS = [
    { zoom: 14, grid: 129, radius: 1 },
    { zoom: 12, grid: 65, radius: 1 },
    { zoom: 10, grid: 65, radius: 1 },
];

// The level a player stands on: heightAt reads this one and no other.
export const GROUND_Z = GROUND_LEVELS[0].zoom;
export const GROUND_GRID = GROUND_LEVELS[0].grid;

// How long a tile whose cut failed is left alone before it is asked for again.
// SPEC §3.12: the elevation service stopping is a thing that stops happening —
// the operator starts it again — so a tile that could not be cut is not a tile
// that is not there. Short, because the ground is what a player is standing on.
export const GROUND_RETRY_MS = 5000;

const key = (z, x, y) => `${z}/${x}/${y}`;

// The block of tiles at this level around (lon, lat), and the lon/lat rectangle
// it covers. The rectangle is what the level below it leaves a hole for.
export function blockAt(level, lon, lat) {
    const { zoom, radius } = level;
    const cx = tm.tileX(lon, zoom);
    const cy = tm.tileY(lat, zoom);
    const tiles = [];
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) tiles.push([zoom, cx + dx, cy + dy]);
    }
    const nw = tm.tileBbox(zoom, cx - radius, cy - radius);
    const se = tm.tileBbox(zoom, cx + radius, cy + radius);
    return { tiles,
        rect: { west: nw.west, north: nw.north, east: se.east, south: se.south } };
}

// The hole a level leaves for the finer one above it, pulled in by a cell of
// its own grid: better a gap the finer level's skirt hangs over than two
// surfaces drawn through each other (client/lib/groundtile.js).
export function holeFor(level, rect) {
    if (!rect) return null;
    const mid = (rect.north + rect.south) / 2;
    const cell = cellMetres(level.zoom, level.grid, mid);
    const dlat = cell / 111320;
    const dlon = cell / (111320 * Math.max(Math.cos(mid * tm.RAD_PER_DEG), 0.01));
    return {
        west: rect.west + dlon, east: rect.east - dlon,
        south: rect.south + dlat, north: rect.north - dlat,
    };
}

export class Ground {
    constructor({ pc, app, origin, filesUrl, fetchFn = fetch,
        levels = GROUND_LEVELS } = {}) {
        Object.assign(this, { pc, app, origin, filesUrl, fetchFn, levels });
        this.localOf = (g) => origin.localOf(g);
        this.tiles = new Map();
        this.entities = new Map();
        this.pending = new Set();
        // A tile the coverage does not reach is a 404, and asking again every
        // frame is a request a second for ever.
        this.nothingThere = new Set();
        // A tile whose cut failed is a different thing: the elevation service
        // said something other than "there is nothing here", and it may say
        // something else in five seconds. Key -> when to ask again.
        this.retryAt = new Map();
        // What went wrong, in the words the server used, while anything is
        // still in trouble. Null once ground arrives again.
        this.troubled = null;
        this.onSaid = null;
        // The hole each level is drawing with, so a tile arriving late is
        // built with the same one its neighbours were.
        this.holes = new Map();
        this.zoom = this.levels[0].zoom;
        this.grid = this.levels[0].grid;
    }

    get count() { return this.tiles.size; }

    // SPEC §3.12: the sentence the page puts where the player is, for as long
    // as the ground under them cannot be cut.
    trouble() { return this.troubled; }

    // The ground under a point, or null when the tile it is in has not
    // arrived. Only the fine level: the coarse ones are a picture of the
    // distance, tens of metres away from the hillside anybody is standing on.
    heightAt(lon, lat) {
        const k = key(this.zoom, tm.tileX(lon, this.zoom), tm.tileY(lat, this.zoom));
        const tile = this.tiles.get(k);
        return tile ? heightIn(tile, lon, lat) : null;
    }

    // Load what is around here and drop what is not. Safe to call every frame:
    // everything it does is either already done or already in flight.
    //
    // `covered(z, x, y)` says that splats are drawn over that ground already.
    // Where they are, this mesh is not drawn: it is the same DEM at a quarter
    // of the samples, so the two surfaces cut through each other and the seam
    // along a compiled tile's edge is the shape of this mesh, not of the
    // world. The heights stay — the player still walks on them where a splat
    // tile has no height of its own — so this only ever hides a picture.
    follow(lon, lat, covered = () => false) {
        const want = new Set();
        let inner = null;
        for (const level of this.levels) {
            const { tiles, rect } = blockAt(level, lon, lat);
            const hole = holeFor(level, inner);
            const was = this.holes.get(level.zoom);
            // The hole moved, so every tile of this level is the wrong shape.
            if (JSON.stringify(was ?? null) !== JSON.stringify(hole)) {
                this.holes.set(level.zoom, hole);
                for (const [k, t] of [...this.tiles]) if (t.z === level.zoom) this.drop(k);
            }
            for (const [z, x, y] of tiles) {
                want.add(key(z, x, y));
                this.load(z, x, y, level, hole);
            }
            inner = rect;
        }
        for (const k of [...this.tiles.keys()]) if (!want.has(k)) this.drop(k);
        for (const [k, entity] of this.entities) {
            const t = this.tiles.get(k);
            if (t) entity.enabled = t.z !== this.zoom || !covered(t.z, t.x, t.y);
        }
        return this.tiles.size;
    }

    load(z, x, y, level, hole) {
        const k = key(z, x, y);
        if (this.tiles.has(k) || this.pending.has(k) || this.nothingThere.has(k)) return;
        if ((this.retryAt.get(k) ?? 0) > Date.now()) return;
        this.retryAt.delete(k);
        this.pending.add(k);
        loadDem(z, x, y, { filesUrl: this.filesUrl, fetchFn: this.fetchFn })
            .then((dem) => {
                this.pending.delete(k);
                // Outside the coverage there is no ground, which is not a
                // failure — it is the edge of the world (SPEC §3.8).
                if (!dem) { this.nothingThere.add(k); return; }
                const tile = groundTile(z, x, y, dem, this.localOf, level.grid,
                    { hole: this.holes.get(z) ?? hole });
                this.tiles.set(k, tile);
                this.troubled = null;
                this.draw(tile);
            })
            .catch((err) => {
                this.pending.delete(k);
                // Not `nothingThere`: the cut failed, which is a thing that
                // stops. Ask again in a moment, and say so meanwhile.
                this.retryAt.set(k, Date.now() + GROUND_RETRY_MS);
                this.troubled = String(err.message ?? err);
                // SPEC §3.12: a tile that could not be cut says so, in words,
                // where the player is — never only in the console.
                this.onSaid?.(`no ground at ${k}: ${this.troubled}`);
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
                this.localOf, tile.grid, { hole: tile.hole });
            this.tiles.set(k, rebuilt);
            this.draw(rebuilt);
        }
    }

    clear() { for (const k of [...this.tiles.keys()]) this.drop(k); }
}
