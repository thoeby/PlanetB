// tiles.js — which tiles to have loaded, and the PlayCanvas entities that hold
// them.
//
// The traversal starts at z6 and refines while the screen-space error of a tile
// is worse than two pixels, and only into children that are all published: a
// half-published level would tear a hole in the world. Everything above
// TileStreamer is a pure function of (published tiles, camera, what is loaded),
// which is what client/test/tiles.test.js flies a scripted path through.

import * as tm from '../lib/tilemath.js';

export const REFINE_PX = 2;
// Coarsening uses a lower threshold than refining, so a camera hovering at the
// boundary does not load and unload the same level every frame.
export const HYSTERESIS = 1.4;
export const LIMITS = { tiles: 40, splats: 25e6, inflight: 4 };

export const key = (z, x, y) => `${z}/${x}/${y}`;
export const parseKey = (k) => {
    const [z, x, y] = k.split('/').map(Number);
    return { z, x, y };
};

// Half the diagonal of the tile on the ground, plus room for terrain relief.
// Used as a bounding sphere for culling and for the distance the error uses.
export function tileRadius(z, x, y) {
    const b = tm.tileBbox(z, x, y);
    const o = tm.tileFrame(z, x, y, 0);
    const w = tm.localFromLonLat(o, b.east, o.lat).x - tm.localFromLonLat(o, b.west, o.lat).x;
    const h = tm.localFromLonLat(o, o.lon, b.north).z - tm.localFromLonLat(o, o.lon, b.south).z;
    return Math.hypot(w, h) / 2 * 1.1;
}

// sse = geometric_error_m * screenH / (2 * dist * tan(fov/2)), with dist taken
// to the bounding sphere rather than its centre so a tile the camera is sitting
// inside does not report an infinite error.
export function screenSpaceError(tile, centre, camera) {
    const d = Math.max(1, Math.hypot(
        camera.position.x - centre.x,
        camera.position.y - centre.y,
        camera.position.z - centre.z) - tile.radius);
    const err = tile.row.manifest?.geometric_error_m ?? tile.radius / 32;
    return err * camera.screenH / (2 * d * Math.tan(camera.fovY / 2));
}

// Planes are [a, b, c, d] with inward normals; a sphere is out if it is fully
// behind any one of them.
export function sphereVisible(centre, radius, planes) {
    if (!planes) return true;
    for (const [a, b, c, d] of planes) {
        if (a * centre.x + b * centre.y + c * centre.z + d < -radius) return false;
    }
    return true;
}

class Candidate {
    constructor(z, x, y, row, origin) {
        this.z = z; this.x = x; this.y = y;
        this.key = key(z, x, y);
        this.row = row;
        this.radius = tileRadius(z, x, y);
        this.centre = origin.localOf(row.manifest.origin);
    }
}

const published = (row) => Boolean(row?.published_version > 0 && row.sog_sha256);

function candidate(world, t) {
    const row = world.tiles.get(key(t.z, t.x, t.y));
    if (!published(row) || !row.manifest?.origin) return null;
    return new Candidate(t.z, t.x, t.y, row, world.origin);
}

// A tile refines only when every child the world says exists is published: a
// child with no `tile` row at all lies outside any compiled area and is not a
// hole, while a child that exists and is unpublished is one, and refining into
// it would tear the ground open. That is why the streamer is given every tile
// row, not only the published ones.
function refinableInto(world, c) {
    const rows = tm.children(c.z, c.x, c.y)
        .map((t) => ({ t, row: world.tiles.get(key(t.z, t.x, t.y)) }))
        .filter((e) => e.row);
    if (!rows.length || !rows.every((e) => published(e.row))) return null;
    return rows.map((e) => new Candidate(e.t.z, e.t.x, e.t.y, e.row, world.origin));
}

// Walks z6 downwards, collecting the tiles that should be on screen.
function traverse(world, camera) {
    const out = [];
    const stack = world.roots.map((t) => candidate(world, t)).filter(Boolean);
    while (stack.length) {
        const c = stack.pop();
        if (!sphereVisible(c.centre, c.radius, camera.planes)) continue;
        c.sse = screenSpaceError(c, c.centre, camera);
        const kids = refinableInto(world, c);
        // Already refined: keep it refined until the error is comfortably under
        // the threshold, not merely under it.
        const isRefined = !world.loaded.has(c.key)
            && kids?.some((k) => world.loaded.has(k.key));
        const threshold = isRefined ? REFINE_PX / HYSTERESIS : REFINE_PX;
        if (kids && c.sse > threshold) stack.push(...kids);
        else out.push(c);
    }
    return out;
}

// Nearest first, then least recently used: the two orders agree on what to drop
// when the caps bite, and the tie-break is what makes the eviction LRU.
function prioritise(world, camera, wanted) {
    return wanted.map((c) => ({
        c,
        d: Math.hypot(camera.position.x - c.centre.x,
            camera.position.y - c.centre.y,
            camera.position.z - c.centre.z),
        used: world.loaded.get(c.key)?.usedAt ?? 0,
    })).sort((a, b) => (a.d - b.d) || (b.used - a.used)).map((e) => e.c);
}

function applyCaps(ordered, limits) {
    const keep = [];
    let splats = 0;
    for (const c of ordered) {
        const n = c.row.manifest?.splats ?? 0;
        if (keep.length >= limits.tiles || splats + n > limits.splats) break;
        keep.push(c);
        splats += n;
    }
    return { keep, splats };
}

// world: { tiles: Map(key -> row), roots: [{z,x,y}], origin, loaded: Map(key ->
// {usedAt}), inflight: number }. camera: { position, planes, screenH, fovY }.
export function selectTiles(world, camera, limits = LIMITS) {
    const ordered = prioritise(world, camera, traverse(world, camera));
    const { keep, splats } = applyCaps(ordered, limits);
    const want = new Set(keep.map((c) => c.key));

    const load = [];
    const room = Math.max(0, limits.inflight - (world.inflight ?? 0));
    for (const c of keep) {
        if (!world.loaded.has(c.key) && load.length < room) load.push(c);
    }
    const unload = [...world.loaded.keys()].filter((k) => !want.has(k))
        .sort((a, b) => (world.loaded.get(a).usedAt - world.loaded.get(b).usedAt));
    return { want, load, unload, splats };
}

// --------------------------------------------------------------- the entities
//
// PlayCanvas is passed in rather than imported: the engine is a CDN global in
// play.html, and handing it over keeps this module loadable under node, where
// the traversal above is tested.

export function cameraState(cameraEntity, screenH) {
    const cc = cameraEntity.camera;
    const p = cameraEntity.getPosition();
    const d = cc.frustum.planeData;
    const planes = [];
    for (let i = 0; i < 6; i++) planes.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]]);
    return {
        position: { x: p.x, y: p.y, z: p.z },
        planes, screenH, fovY: cc.fov * tm.RAD_PER_DEG,
    };
}

export class TileStreamer {
    constructor(app, pc, { origin, filesUrl, limits = LIMITS } = {}) {
        this.app = app;
        this.pc = pc;
        this.origin = origin;
        this.filesUrl = filesUrl ?? '';
        this.limits = limits;
        this.tiles = new Map();
        this.roots = [];
        this.entries = new Map();
        this.pending = 0;
        this.clock = 0;
    }

    // rows: every row of GET /api/tile, published or not — refinableInto()
    // needs to tell an unpublished child from one that does not exist.
    setTiles(rows) {
        this.tiles = new Map(rows.map((r) => [key(r.z, r.x, r.y), r]));
        this.roots = rows.filter((r) => r.z === tm.MIN_ZOOM && r.published_version > 0)
            .map((r) => ({ z: r.z, x: r.x, y: r.y }));
        return this.tiles.size;
    }

    world() {
        return {
            tiles: this.tiles, roots: this.roots, origin: this.origin,
            loaded: this.entries, inflight: this.pending,
        };
    }

    update(camera) {
        const sel = selectTiles(this.world(), camera, this.limits);
        for (const k of sel.want) {
            const e = this.entries.get(k);
            if (e) e.usedAt = ++this.clock;
        }
        for (const k of sel.unload) this.unload(k);
        for (const c of sel.load) this.begin(c);
        return sel;
    }

    url(c) {
        return `${this.filesUrl}/tiles/${c.z}/${c.x}/${c.y}/${c.row.sog_sha256}.sog`;
    }

    begin(c) {
        if (this.entries.has(c.key)) return;
        const asset = new this.pc.Asset(c.key, 'gsplat', {
            url: this.url(c), filename: `${c.row.sog_sha256}.sog`,
        });
        const entry = { usedAt: ++this.clock, row: c.row, asset, entity: null };
        this.entries.set(c.key, entry);
        this.pending++;
        // The in-flight count must fall exactly once per load, whichever way it
        // ends — ready, error, or unloaded while still in the air.
        const settle = () => {
            if (entry.settled) return false;
            entry.settled = true;
            this.pending--;
            return true;
        };
        asset.ready(() => {
            if (!settle() || this.entries.get(c.key) !== entry) return;
            const entity = new this.pc.Entity(c.key);
            entity.addComponent('gsplat', { asset });
            this.place(entity, c.row);
            this.app.root.addChild(entity);
            entry.entity = entity;
        });
        asset.once('error', (err) => {
            if (!settle()) return;
            this.entries.delete(c.key);
            this.app.assets.remove(asset);
            console.warn(`tile ${c.key} failed to load: ${err}`);
        });
        this.app.assets.add(asset);
        this.app.assets.load(asset);
    }

    // The tile's splats are in its own ENU frame; the scene is in the anchor's.
    // Two frames that far apart differ by a rotation as well as an offset.
    place(entity, row) {
        const p = this.origin.localOf(row.manifest.origin);
        entity.setLocalPosition(p.x, p.y, p.z);
        const q = tm.matrixToQuaternion(tm.enuRotation(row.manifest.origin, this.origin.anchor));
        entity.setLocalRotation(q[0], q[1], q[2], q[3]);
    }

    unload(k) {
        const e = this.entries.get(k);
        if (!e) return;
        if (!e.settled) {
            e.settled = true;
            this.pending--;
        }
        e.entity?.destroy();
        if (e.asset) {
            this.app.assets.remove(e.asset);
            e.asset.unload();
        }
        this.entries.delete(k);
    }

    // Moves the anchor under the camera when it has drifted, and re-places every
    // entity from its own geodetic origin. Returns the camera's new position.
    rebase(cameraLocal) {
        const moved = this.origin.rebase(cameraLocal);
        if (!moved) return null;
        for (const e of this.entries.values()) {
            if (e.entity) this.place(e.entity, e.row);
        }
        return moved;
    }
}
