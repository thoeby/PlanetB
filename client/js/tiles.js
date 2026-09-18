// tiles.js — the PlayCanvas entities that hold the world's tiles, and the poll
// that swaps one when it is republished.
//
// Which tiles to have loaded is client/js/traverse.js: that half is a pure
// function and is tested under node.

import * as tm from '../lib/tilemath.js';
import { LIMITS, POLL_MS, RETRY_MS, key, parseKey, selectTiles, showing }
    from './traverse.js';

export { LIMITS, WEBGL_LIMITS, POLL_MS, RETRY_MS, key, parseKey, selectTiles, showing,
    REFINE_PX, HYSTERESIS, tileRadius, screenSpaceError, sphereVisible }
    from './traverse.js';

// --------------------------------------------------------------- the entities
//
// PlayCanvas is passed in rather than imported: the engine is a CDN global in
// play.html, and handing it over keeps this module loadable under node, where
// the traversal above is tested.

// The frustum is built here from the camera node's current transform rather
// than read off the component: the engine's frustum, and its view matrix, are
// the ones it last rendered with, a frame behind, and a selection made with
// them culls against where the camera was. `pc` is the engine; without it the
// rendered frustum is used.
let scratch = null;

export function cameraState(cameraEntity, screenH, pc = null) {
    const cc = cameraEntity.camera;
    const p = cameraEntity.getPosition();
    let d = cc.frustum.planeData;
    if (pc) {
        scratch ??= { frustum: new pc.Frustum(), view: new pc.Mat4(), mat: new pc.Mat4() };
        scratch.view.copy(cameraEntity.getWorldTransform()).invert();
        scratch.frustum.setFromMat4(scratch.mat.mul2(cc.projectionMatrix, scratch.view));
        d = scratch.frustum.planeData;
    }
    const planes = [];
    for (let i = 0; i < 6; i++) planes.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]]);
    return {
        position: { x: p.x, y: p.y, z: p.z },
        planes, screenH, fovY: cc.fov * tm.RAD_PER_DEG,
    };
}

// Whether a loaded asset's splats are on the device.
//
// A single-level .sog is ready when its splats are decoded. An octree asset is
// ready when its *index* parses; the file it names is fetched afterwards by the
// octree's own loader. A tile's octree names exactly one file, so file 0 is the
// tile. These are the engine fields this file depends on (PlayCanvas 2.22,
// pinned by tools/vendor.sh): re-read this one function on a version bump.
export function splatsHere(entry) {
    const resource = entry?.asset?.resource;
    if (!resource) return false;
    const octree = resource.octree;
    return octree ? Boolean(octree.getFileResource(0)) : true;
}

// How long a placed tile is given to produce its splats before it is counted
// as drawing anyway, with a complaint. The octree's loader retries twice and
// then puts the url aside silently — nothing fires an error this file could
// hear — so without this a 404 on one .sog would wedge refine, coarsen and the
// swap for ever. It degrades the picture; it cannot stop the world.
export const RESIDENT_MS = 10000;

// Where the traversal starts: every published tile with no published tile above
// it. A world compiles from the leaves up (SPEC §5.3) — the first thing anybody
// publishes is a z14, and its z12, z10, z8 and z6 are rebuilt from it
// afterwards — so a traversal that could only start at z6 showed nothing at all
// until the whole ladder had been rebuilt. Where the ladder is complete, the z6
// is still the only root, because every finer tile has it above them.
function rootsOf(rows) {
    const live = new Set(rows.filter((r) => r.published_version > 0)
        .map((r) => key(r.z, r.x, r.y)));
    const covered = (r) => {
        for (let z = r.z - 2; z >= tm.MIN_ZOOM; z -= 2) {
            const f = 2 ** (r.z - z);
            if (live.has(key(z, Math.floor(r.x / f), Math.floor(r.y / f)))) return true;
        }
        return false;
    };
    return rows.filter((r) => r.published_version > 0 && !covered(r))
        .map((r) => ({ z: r.z, x: r.x, y: r.y }));
}

export class TileStreamer {
    constructor(app, pc, { origin, filesUrl, limits = LIMITS, fetchRows } = {}) {
        this.app = app;
        this.pc = pc;
        this.origin = origin;
        this.filesUrl = filesUrl ?? '';
        this.limits = limits;
        // Off: everybody sees what has been approved. On: an owner or an
        // approver sees what was rendered, in place, before saying yes (T7).
        this.candidates = false;
        // Asked for the current published_version and sog_sha256 of the tiles
        // that are loaded, and for every tile published since the last time it
        // was asked. Injected rather than imported so this module stays
        // loadable under node, where the traversal is tested.
        this.fetchRows = fetchRows ?? null;
        this.since = new Date().toISOString();
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
        // Tiles whose bytes have arrived, waiting for their frame in the scene.
        this.arrived = [];
    }

    // rows: every row of GET /api/tile, published or not — refinableInto()
    // needs to tell an unpublished child from one that does not exist.
    setTiles(rows) {
        this.tiles = new Map(rows.map((r) => [key(r.z, r.x, r.y), r]));
        this.roots = rootsOf(rows);
        return this.tiles.size;
    }

    world() {
        return {
            tiles: this.tiles, roots: this.roots, origin: this.origin,
            loaded: this.entries, inflight: this.pending,
            candidates: this.candidates,
            failed: this.failed, now: Date.now(),
        };
    }

    update(camera) {
        this.settleResidency(Date.now());
        this.placeNext();
        const sel = selectTiles(this.world(), camera, this.limits);
        const now = Date.now();
        for (const k of sel.want) {
            const e = this.entries.get(k);
            if (e) { e.usedAt = ++this.clock; e.seenAt = now; }
        }
        for (const k of sel.unload) this.unload(k);
        for (const c of sel.load) this.begin(c);
        return sel;
    }

    // A placed tile starts drawing when its splats arrive, and a swap finishes
    // then too: until the tile taking a tile's place has something in it, the
    // old one stays. Called once per update, before anything is decided.
    settleResidency(now) {
        for (const [k, e] of this.entries) {
            if (e.pending && (splatsHere(e.pending) || now - e.pending.placedAt > RESIDENT_MS)) {
                this.finishSwap(k, e);
            }
            if (!e.entity || e.resident) continue;
            if (splatsHere(e)) e.resident = true;
            else if (now - e.placedAt > RESIDENT_MS) {
                e.resident = true;
                console.warn(`tile ${k}: no splats ${RESIDENT_MS} ms after it was placed`);
            }
        }
    }

    // What to fetch for a tile, and what to tell the engine it is called.
    //
    // PlayCanvas picks its parser from the asset's *declared* filename and
    // fetches from the url (framework/handlers/loader.js), so a tile's levels
    // are stored content-addressed like everything else and only *called*
    // `lod-meta.json` — the name the octree parser matches on. Invariant 1 is
    // untouched (client/atoms/sog.js).
    //
    // A tile published before sog-v2 carries no levels and is loaded as the
    // single-level .sog it is. That arm is not a switch anybody can set; it is
    // the same "if the manifest says so" as `manifest.height`, and it goes
    // when nothing in the world is older than sog-v2.
    fileOf(c) {
        const shown = showing(c.row, this.candidates);
        const sha = shown?.sha ?? c.row.sog_sha256;
        const dir = `${this.filesUrl}/tiles/${c.z}/${c.x}/${c.y}`;
        const lod = shown?.manifest?.lod;
        return lod
            ? { url: `${dir}/${lod.sha256}.json`, filename: 'lod-meta.json' }
            : { url: `${dir}/${sha}.sog`, filename: `${sha}.sog` };
    }

    url(c) {
        return this.fileOf(c).url;
    }

    begin(c) {
        if (this.entries.has(c.key)) return;
        const asset = new this.pc.Asset(c.key, 'gsplat', this.fileOf(c));
        // `resident` is whether this tile's splats are on screen, which is a
        // different question from whether it has an entity: a tile with levels
        // has an entity as soon as its index parses and nothing in it until the
        // file that index names arrives (`splatsHere`). The ground and the
        // traversal ask this one; `pending` is the same question for a tile
        // waiting to take another's place.
        const entry = { usedAt: ++this.clock, seenAt: Date.now(), row: c.row,
            asset, entity: null, resident: false, placedAt: 0, pending: null };
        this.entries.set(c.key, entry);
        this.pending++;
        // The in-flight count must fall exactly once per load, whichever way it
        // ends — placed, error, or unloaded while still in the air.
        entry.settle = () => {
            if (entry.settled) return false;
            entry.settled = true;
            this.pending--;
            return true;
        };
        // Not placed here: every splat set added to the scene has the engine
        // re-sort the world, so arrivals are spaced one per frame by placeNext()
        // rather than landing together and stalling one frame for all of them.
        asset.ready(() => {
            // Unloaded while in the air: the bytes arrived for nobody.
            if (this.entries.get(c.key) !== entry) return this.release(null, asset);
            this.arrived.push(entry);
        });
        asset.once('error', (err) => {
            if (!entry.settle()) return;
            this.entries.delete(c.key);
            this.failed.set(c.key, Date.now() + RETRY_MS);
            this.app.assets.remove(asset);
            console.warn(`tile ${c.key} failed to load: ${err}`);
        });
        this.app.assets.add(asset);
        this.app.assets.load(asset);
    }

    // Puts one arrived tile into the scene. Called once per frame.
    placeNext() {
        while (this.arrived.length) {
            const entry = this.arrived.shift();
            const k = entry.asset.name;
            if (this.entries.get(k) !== entry) continue;   // unloaded since it arrived
            if (!entry.settle()) continue;
            this.failed.delete(k);
            const entity = new this.pc.Entity(k);
            entity.addComponent('gsplat', { asset: entry.asset });
            this.place(entity, entry.row);
            this.app.root.addChild(entity);
            entry.entity = entity;
            entry.placedAt = Date.now();
            entry.resident = splatsHere(entry);
            return entry;
        }
        return null;
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
        if (e.pending) {
            this.release(e.pending.entity, e.pending.asset);
            e.pending = null;
        }
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

    // A tile published while this page is open is a tile the traversal has to
    // learn about: a z16 that was unpublished when the rows were fetched is one
    // the parent could not refine into, and re-checking only what is loaded
    // never found it. So the poll asks after the loaded tiles and after every
    // tile published since it last asked.
    async poll() {
        if (!this.fetchRows || !this.tiles.size) return 0;
        const since = this.since;
        this.since = new Date().toISOString();
        const rows = await this.fetchRows([...this.entries.keys()].map(parseKey), since);
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
        const asset = new this.pc.Asset(`${k}@${row.published_version}`, 'gsplat',
            this.fileOf({ z: row.z, x: row.x, y: row.y, key: k, row }));
        asset.ready(() => this.adopt(k, e, asset, row));
        asset.once('error', () => {
            if (e.swapping === row.sog_sha256) e.swapping = null;
            this.app.assets.remove(asset);
        });
        this.app.assets.add(asset);
        this.app.assets.load(asset);
    }

    // The new asset's index has arrived: put it in the scene beside the old
    // one and wait. It is not the tile until it has splats in it — for a few
    // frames both are there, which the balancer answers by drawing a little
    // less of each, and which is the price of never showing a hole.
    adopt(k, e, asset, row) {
        if (this.entries.get(k) !== e || e.swapping !== row.sog_sha256) {
            this.release(null, asset);
            return;
        }
        const entity = new this.pc.Entity(k);
        entity.addComponent('gsplat', { asset });
        this.place(entity, row);
        this.app.root.addChild(entity);
        e.pending = { entity, asset, row, placedAt: Date.now() };
        this.settleResidency(Date.now());
    }

    // The parked tile has splats (or has run out of time): it becomes the tile,
    // and the one it replaced goes.
    finishSwap(k, e) {
        const { entity, asset, row } = e.pending;
        const oldEntity = e.entity, oldAsset = e.asset;
        e.entity = entity;
        e.asset = asset;
        e.row = row;
        e.resident = true;
        e.placedAt = Date.now();
        e.pending = null;
        e.swapping = null;
        this.swaps++;
        this.release(oldEntity, oldAsset);
        this.onRelease?.(k);
    }
}
