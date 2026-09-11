// tiles.js — the PlayCanvas entities that hold the world's tiles, and the poll
// that swaps one when it is republished.
//
// Which tiles to have loaded is client/js/traverse.js: that half is a pure
// function and is tested under node.

import * as tm from '../lib/tilemath.js';
import { LIMITS, POLL_MS, RETRY_MS, key, parseKey, selectTiles, showing }
    from './traverse.js';

export { LIMITS, POLL_MS, RETRY_MS, key, parseKey, selectTiles, showing,
    REFINE_PX, HYSTERESIS, tileRadius, screenSpaceError, sphereVisible }
    from './traverse.js';

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
        // Off: everybody sees what has been approved. On: an owner or an
        // approver sees what was rendered, in place, before saying yes (T7).
        this.candidates = false;
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
            candidates: this.candidates,
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
        const sha = showing(c.row, this.candidates)?.sha ?? c.row.sog_sha256;
        return `${this.filesUrl}/tiles/${c.z}/${c.x}/${c.y}/${sha}.sog`;
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
