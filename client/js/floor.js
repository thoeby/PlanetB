// floor.js — the ground under your feet where nothing is published yet.
//
// The floor is the finest published tile's height file (client/js/player.js
// Terrain); until a tile is published there is none, and a player in walk
// mode hung in the air. This reads the elevation the world stands on —
// the same /geo/dem tile the compile reads, at z14 — and answers a height in
// metres above sea level. It draws nothing and makes nothing: one fetch per
// tile, kept, and null while it is on its way.

import { inTile } from '../lib/demshade.js';
import { loadDem, sampleHeight } from '../lib/geo.js';
import * as tm from '../lib/tilemath.js';

const Z = 14;
const RETRY_MS = 10_000;

export class DemFloor {
    constructor({ filesUrl = '', fetchFn = fetch } = {}) {
        this.filesUrl = filesUrl;
        this.fetchFn = fetchFn;
        this.tiles = new Map();
        this.pending = new Set();
        // What the store said the last time it could not cut a tile, and
        // nothing once one arrives. SPEC §3.12: the player standing on ground
        // that cannot be cut is told, in place, in the words the server used.
        this.trouble = '';
    }

    heightAt(lon, lat) {
        const x = tm.tileX(lon, Z);
        const y = tm.tileY(lat, Z);
        const k = `${x}/${y}`;
        const dem = this.tiles.get(k);
        if (dem === undefined) { this.request(k, x, y); return null; }
        if (dem === null) return null;
        const { u, v } = inTile(Z, x, y, lon, lat);
        return sampleHeight(dem, u, v);
    }

    request(k, x, y) {
        if (this.pending.has(k)) return;
        this.pending.add(k);
        loadDem(Z, x, y, { filesUrl: this.filesUrl, fetchFn: this.fetchFn })
            .then((dem) => { this.tiles.set(k, dem); this.trouble = ''; })
            // A tile the store could not cut is asked for again, but not on
            // the next frame: a ground that answers 502 met a request storm.
            // What it said is kept, because it is the one thing the player
            // standing there needs to read.
            .catch((err) => {
                this.trouble = String(err?.message ?? err);
                setTimeout(() => this.pending.delete(k), RETRY_MS);
            });
    }
}
