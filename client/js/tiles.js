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
// How often a loaded tile is re-checked for a newer published version.
export const POLL_MS = 30000;
// How long a tile that failed to load is left alone before it is tried again.
export const RETRY_MS = 30000;

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

// A tile whose load failed is left alone until its retry time; until then it
// is treated as unpublished, so its parent stays whole.
const loadable = (world, k) => !((world.failed?.get(k) ?? 0) > (world.now ?? 0));

function candidate(world, t) {
    const k = key(t.z, t.x, t.y);
    const row = world.tiles.get(k);
    if (!published(row) || !row.manifest?.origin || !loadable(world, k)) return null;
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
    if (!rows.every((e) => loadable(world, key(e.t.z, e.t.x, e.t.y)))) return null;
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

// One tile covers the other's ground: the same tile, an ancestor or a descendant.
function overlaps(a, b) {
    const [hi, lo] = a.z <= b.z ? [a, b] : [b, a];
    const f = 2 ** (lo.z - hi.z);
    return Math.floor(lo.x / f) === hi.x && Math.floor(lo.y / f) === hi.y;
}

// A tile on its way out stays until every tile taking its place is in the
// scene (an entry with `entity: null` is still loading): no frame with a hole.
function replaced(world, keep, k) {
    const t = parseKey(k);
    return keep.filter((c) => overlaps(t, c))
        .every((c) => world.loaded.has(c.key) && world.loaded.get(c.key).entity !== null);
}

// world: { tiles: Map(key -> row), roots: [{z,x,y}], origin, loaded: Map(key ->
// {usedAt, entity?}), inflight: number, failed?: Map(key -> retryAt), now? }.
// camera: { position, planes, screenH, fovY }.
export function selectTiles(world, camera, limits = LIMITS) {
    const ordered = prioritise(world, camera, traverse(world, camera));
    const { keep, splats } = applyCaps(ordered, limits);
    const want = new Set(keep.map((c) => c.key));

    const load = [];
    const room = Math.max(0, limits.inflight - (world.inflight ?? 0));
    for (const c of keep) {
        if (!world.loaded.has(c.key) && load.length < room) load.push(c);
    }
    const unload = [...world.loaded.keys()]
        .filter((k) => !want.has(k) && replaced(world, keep, k))
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
    constructor(app, pc, { origin, filesUrl, limits = LIMITS, fetchRows } = {}) {
        this.app = app;
        this.pc = pc;
        this.origin = origin;
        this.filesUrl = filesUrl ?? '';
        this.limits = limits;
        // Asked for the current published_version and sog_sha256 of the tiles
        // that are loaded. Injected rather than imported so this module stays
        // loadable under node, where the traversal is tested.
        this.fetchRows = fetchRows ?? null;
        // Told the key of every tile whose splats leave the scene, whether it
        // was unloaded or swapped for a newer version (client/js/player.js).
        this.onRelease = null;
        this.timer = null;
        this.swaps = 0;
        this.tiles = new Map();
        this.roots = [];
        this.entries = new Map();
        this.failed = new Map();
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
            failed: this.failed, now: Date.now(),
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
            // Unloaded while in the air: the bytes arrived for nobody.
            if (!settle() || this.entries.get(c.key) !== entry) return this.release(null, asset);
            this.failed.delete(c.key);
            const entity = new this.pc.Entity(c.key);
            entity.addComponent('gsplat', { asset });
            this.place(entity, c.row);
            this.app.root.addChild(entity);
            entry.entity = entity;
        });
        asset.once('error', (err) => {
            if (!settle()) return;
            this.entries.delete(c.key);
            this.failed.set(c.key, Date.now() + RETRY_MS);
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
        this.release(e.entity, e.asset);
        this.entries.delete(k);
        this.onRelease?.(k);
    }

    // The engine's splat sorter can still hold a placement it collected earlier
    // in the frame; destroying its entity now leaves it one with no resource.
    // Disabling takes it out of the scene at once; the memory goes a tick later.
    release(entity, asset) {
        if (entity) entity.enabled = false;
        setTimeout(() => {
            entity?.destroy();
            if (asset) { this.app.assets.remove(asset); asset.unload(); }
        }, 0);
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

    // --------------------------------------------------------------- hot swap
    //
    // A tile republished while it is on screen is replaced, not reloaded: the
    // new asset is built alongside the old one and the old entity is destroyed
    // only once the new one is in the scene, so there is never a frame without
    // the tile.

    startPolling(intervalMs = POLL_MS) {
        this.stopPolling();
        this.timer = setInterval(() => { this.poll().catch(() => {}); }, intervalMs);
        return this.timer;
    }

    stopPolling() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async poll() {
        if (!this.fetchRows || !this.entries.size) return 0;
        const rows = await this.fetchRows([...this.entries.keys()].map(parseKey));
        let swapped = 0;
        for (const row of rows ?? []) {
            const k = key(row.z, row.x, row.y);
            const e = this.entries.get(k);
            this.tiles.set(k, row);
            if (!e || !row.sog_sha256 || row.sog_sha256 === e.row.sog_sha256) continue;
            this.swap(k, row);
            swapped++;
        }
        return swapped;
    }

    // `swapping` is the sha most recently asked for: when two versions are in
    // flight, only the newest is adopted and the other is dropped on arrival.
    swap(k, row) {
        const e = this.entries.get(k);
        if (!e || e.swapping === row.sog_sha256) return;
        e.swapping = row.sog_sha256;
        const asset = new this.pc.Asset(`${k}@${row.published_version}`, 'gsplat', {
            url: this.url({ z: row.z, x: row.x, y: row.y, row }),
            filename: `${row.sog_sha256}.sog`,
        });
        asset.ready(() => this.adopt(k, e, asset, row));
        asset.once('error', () => {
            if (e.swapping === row.sog_sha256) e.swapping = null;
            this.app.assets.remove(asset);
        });
        this.app.assets.add(asset);
        this.app.assets.load(asset);
    }

    // The new asset has arrived: put it in the scene, then take the old one out.
    adopt(k, e, asset, row) {
        if (this.entries.get(k) !== e || e.swapping !== row.sog_sha256) {
            this.release(null, asset);
            return;
        }
        const entity = new this.pc.Entity(k);
        entity.addComponent('gsplat', { asset });
        this.place(entity, row);
        this.app.root.addChild(entity);
        const oldEntity = e.entity, oldAsset = e.asset;
        e.entity = entity;
        e.asset = asset;
        e.row = row;
        e.swapping = null;
        this.swaps++;
        this.release(oldEntity, oldAsset);
        this.onRelease?.(k);
    }
}
