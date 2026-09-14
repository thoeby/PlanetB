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
// Four levels of it, not one. A ring of z14 tiles is five kilometres of floor,
// which is a walk — and standing on a mountain looking at five kilometres of
// world with nothing behind it is the horizon falling away. So the ring you
// walk on is drawn inside a ring of z12 and one of z10, each of them a hole
// with the finer one in it (client/lib/groundtile.js), and the far one reaches
// forty kilometres. In front of all of them is a z16 ring: 3 m cells over the
// ground within sight of your feet, which is the difference between a hillside
// and the idea of one. Only the two fine levels are walked on; the coarse ones
// are a picture of where you are, not ground anybody stands on.

import { loadDem } from './geo.js';
import * as tm from './tilemath.js';
import { cellMetres, groundTile, heightIn } from './groundtile.js';

export { cellMetres, groundTile, heightIn } from './groundtile.js';

// Fine first. `radius` is how many tiles either side of the one you are on, so
// 1 is a three-by-three block: 1.3 km at z16, 5 km at z14, 10 km at z12, 40 km
// at z10.
//
// The grid coarsens with the level because the far ones are a silhouette. z16
// and z14 keep 129 — they are the floor, and the compile's own terrain is 129.
// The grid is what says how much of the DEM is used. A cut tile is 256 samples
// across (server/splatworld/importer.py), so 65 threw away three quarters of
// the ground a player is standing on; 129 is what the compile's own terrain
// uses and is the same hillside with its shape in it.
//
// z16 is 3.3 m a cell at Alpine latitudes against z14's 13.2, and inside a
// single z14 tile — 1.7 km of it — nothing used to sharpen as you walked up to
// it, because there was no level in front of it. It costs nine more cuts of
// the operator's elevation service, each one 256² of the same rectangle the
// compile asks for.
export const GROUND_LEVELS = [
    { zoom: 16, grid: 129, radius: 1 },
    { zoom: 14, grid: 129, radius: 1 },
    { zoom: 12, grid: 65, radius: 1 },
    { zoom: 10, grid: 65, radius: 1 },
];

// The finest level, and the coarsest cell a player may stand on. A level below
// this is a picture of the distance: a 106 m cell is tens of metres away from
// the hillside anybody is really standing on, and walking on it would put them
// in the air or under the ground. heightAt reads the levels above the line and
// stops there; heightNear, which draws pictures, reads them all.
export const GROUND_Z = GROUND_LEVELS[0].zoom;
export const GROUND_GRID = GROUND_LEVELS[0].grid;
export const STANDABLE_CELL_M = 20;

// How long a tile whose cut failed is left alone before it is asked for again.
// SPEC §3.12: the elevation service stopping is a thing that stops happening —
// the operator starts it again — so a tile that could not be cut is not a tile
// that is not there. Short, because the ground is what a player is standing on.
export const GROUND_RETRY_MS = 5000;

// How many tiles of ground may be in the air at once. Each one the store has
// not got is a cut: the server asks the operator's elevation service for that
// rectangle and warps it (server/splatworld/ground.py). Asking for a whole
// three-level ring at once is twenty-seven of those in one breath, which is
// half a minute of somebody's GeoServer and a page that does nothing while it
// waits. Fine tiles ask first, because they are the ground underfoot.
export const GROUND_INFLIGHT = 3;

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
    // `within` is the operator's coverage as {west, south, east, north}: the
    // edge of the world, past which no ground is drawn.
    constructor({ pc, app, origin, filesUrl, fetchFn = fetch,
        levels = GROUND_LEVELS, within = null } = {}) {
        Object.assign(this, { pc, app, origin, filesUrl, fetchFn, levels, within });
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

    // The ground under a point, or null when no level fine enough to stand on
    // has it. The fine levels, finest first: a z16 tile is 3.3 m a cell and a
    // z14 one 13.2, and either is the hillside; a z12 tile is 106 m a cell,
    // which is a picture of the distance, so walking on it is not offered.
    // Asking the finest level and no other left a player standing in the air
    // everywhere the z16 cut had not arrived yet.
    heightAt(lon, lat) {
        for (const level of this.standable()) {
            const { zoom } = level;
            const tile = this.tiles.get(
                key(zoom, tm.tileX(lon, zoom), tm.tileY(lat, zoom)));
            if (!tile) continue;
            const h = heightIn(tile, lon, lat);
            if (h !== null && h !== undefined) return h;
        }
        return null;
    }

    // The levels whose cells are small enough to be somebody's floor. Measured
    // at the equator, where a cell is widest: a level that passes there passes
    // everywhere, so the floor is the same rule at every latitude.
    standable() {
        return this.levels.filter(
            (l) => cellMetres(l.zoom, l.grid, 0) <= STANDABLE_CELL_M);
    }

    // The same question for something that is drawing a picture rather than
    // deciding where a body is: the finest level that has this point, down to
    // the coarsest. The fine block is three tiles across and the map is
    // twenty kilometres, so heightAt answers for the middle of the map and
    // nothing else — which is a map with land in the middle of it and a grid
    // all round. Nobody standing on a hill should be told where they are by a
    // 400 m cell; nobody looking at a map minds.
    heightNear(lon, lat) {
        for (const level of this.levels) {
            const { zoom } = level;
            const tile = this.tiles.get(
                key(zoom, tm.tileX(lon, zoom), tm.tileY(lat, zoom)));
            if (!tile) continue;
            const h = heightIn(tile, lon, lat);
            if (h !== null && h !== undefined) return h;
        }
        return null;
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
        // The floor first, and the distance behind it. A page opening asks for
        // three rings at once otherwise, and every tile the store has not got
        // is a cut — the server asking the operator's elevation service for
        // that rectangle and warping it. Twenty-seven of those in one breath is
        // a page that stands still while the ground it is standing on waits
        // behind the ground forty kilometres away.
        //
        // "The floor" is every level fine enough to stand on, not only the
        // finest: what a player walks on is z16 where it has arrived and z14
        // where it has not, and the ray that finds the ground under a click
        // reaches four hundred metres (client/js/build.js), which is further
        // than the z16 ring. Making z14 queue behind z16 shortened the ground
        // to whatever the fine ring covered until the rest caught up, and a
        // click past that put nothing down.
        let ready = true;
        const floor = new Set(this.standable().map((l) => l.zoom));
        for (const level of this.levels) {
            const { tiles, rect } = blockAt(level, lon, lat);
            const hole = holeFor(level, inner);
            const was = this.holes.get(level.zoom);
            // The hole moved, so every tile of this level is the wrong shape.
            // Rebuilt from the samples it already holds, never refetched: the
            // finest ring is 420 m across, so crossing into the next one
            // reshapes the three levels behind it, and throwing the bytes away
            // each time would ask the operator's elevation service for the
            // same rectangle every few hundred metres of walking.
            if (JSON.stringify(was ?? null) !== JSON.stringify(hole)) {
                this.holes.set(level.zoom, hole);
                this.reshape(level, hole);
            }
            for (const [z, x, y] of tiles) {
                want.add(key(z, x, y));
                if (ready || floor.has(level.zoom)) this.load(z, x, y, level, hole);
            }
            ready = ready && tiles.every(([z, x, y]) => this.settled(key(z, x, y)));
            inner = rect;
        }
        for (const k of [...this.tiles.keys()]) if (!want.has(k)) this.drop(k);
        for (const [k, entity] of this.entities) {
            const t = this.tiles.get(k);
            if (t) entity.enabled = t.z !== this.zoom || !covered(t.z, t.x, t.y);
        }
        return this.tiles.size;
    }

    // Every tile of one level, built again around the hole it now has to leave
    // for the finer level in front of it. The DEM it was cut from is on the
    // tile, so this is arithmetic and a mesh, not a request.
    reshape(level, hole) {
        for (const [k, tile] of [...this.tiles]) {
            if (tile.z !== level.zoom) continue;
            this.drop(k);
            const rebuilt = groundTile(tile.z, tile.x, tile.y, tile.dem,
                this.localOf, level.grid, { hole, within: this.within });
            this.tiles.set(k, rebuilt);
            this.draw(rebuilt);
        }
    }

    // Whether a cut of this level is already in the air.
    inFlight(zoom) {
        for (const k of this.pending) if (k.startsWith(`${zoom}/`)) return true;
        return false;
    }

    // Nothing more is going to happen about this tile: it is drawn, there is
    // no ground there, or it failed and is waiting to be asked again.
    settled(k) {
        return this.tiles.has(k) || this.nothingThere.has(k)
            || (this.retryAt.get(k) ?? 0) > Date.now();
    }

    load(z, x, y, level, hole) {
        const k = key(z, x, y);
        if (this.tiles.has(k) || this.pending.has(k) || this.nothingThere.has(k)) return;
        // Over the budget, one level may still have one cut in the air: nine
        // tiles of the fine ring otherwise hold every slot there is for as
        // long as the operator's elevation service takes to answer them, and
        // the level behind — which is the rest of the ground a player stands
        // on — does not start until they are done. The cap is therefore a cap
        // per level as well as in total, and the total is at most one more
        // than the number of levels.
        if (this.pending.size >= GROUND_INFLIGHT && this.inFlight(level.zoom)) return;
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
                    { hole: this.holes.get(z) ?? hole, within: this.within });
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
                this.localOf, tile.grid,
                { hole: tile.hole, within: tile.within });
            this.tiles.set(k, rebuilt);
            this.draw(rebuilt);
        }
    }

    clear() { for (const k of [...this.tiles.keys()]) this.drop(k); }
}
