// floor.js — the ground under your feet where nothing is published yet.
//
// The floor is the finest published tile's height file (client/js/player.js
// Terrain); until a tile is published there is none, and a player in walk
// mode hung in the air. This reads the elevation the world stands on —
// the same /geo/dem tile the compile reads, at z14 — and answers a height in
// metres above sea level. It draws nothing and makes nothing: one fetch per
// tile, kept, and null while it is on its way.

import { inTile } from '../lib/demshade.js';
import { NODATA_ELEVATION_M, loadDem, sampleHeight } from '../lib/geo.js';
import * as tm from '../lib/tilemath.js';

const Z = 14;
// Every level the store cuts, coarsest first (server/splatworld/ground.py
// parse_request, client/lib/geo.js MIN_Z).
const LEVELS = [6, 8, 10, 12, 14];
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
        return this.at(Z, lon, lat);
    }

    // The height at a point for something drawing a map rather than standing
    // on the ground: the finest level already in hand, and when none is, the
    // coarsest one is what gets asked for.
    //
    // `heightAt` asks at z14 and only z14, one cut per 1.7 km. A map twenty
    // kilometres across probes a hundred and forty of them in a tick, every
    // one a separate request, and answers null for all of them until they
    // land — so the map drew the one tile it already had and black
    // everywhere else. A single z6 cut covers the whole of it, and the finer
    // levels sharpen it as they arrive.
    heightNear(lon, lat) {
        let best = null;
        let ask = null;
        for (const z of LEVELS) {
            const x = tm.tileX(lon, z);
            const y = tm.tileY(lat, z);
            const k = `${z}/${x}/${y}`;
            const dem = this.tiles.get(k);
            if (dem === undefined) { ask = ask ?? [k, z, x, y]; continue; }
            if (dem === null) continue;
            const { u, v } = inTile(z, x, y, lon, lat);
            const h = sampleHeight(dem, u, v);
            if (h !== null && h !== undefined && h !== NODATA_ELEVATION_M) best = h;
        }
        if (best === null && ask) this.request(...ask);
        return best;
    }

    // A cut is refused only when the whole window it was asked for is fill
    // (client/lib/geo.js loadRaster, allNodata), so a tile that straddles the
    // edge of the survey arrives with ground in one half and fill in the
    // other, and a coarse tile asked for as itself — which heightNear does
    // — arrives whenever it holds ground anywhere at all. The fill is
    // written as an elevation of zero (server/splatworld/dem.py), and
    // sampleHeight does not know it from sea level: unfiltered, a map drew
    // half a continent of ground at 0 m because one corner of a z6 cut was
    // surveyed. Outside the survey there is no height, and this says so.
    at(z, lon, lat) {
        const x = tm.tileX(lon, z);
        const y = tm.tileY(lat, z);
        const k = `${z}/${x}/${y}`;
        const dem = this.tiles.get(k);
        if (dem === undefined) { this.request(k, z, x, y); return null; }
        if (dem === null) return null;
        const { u, v } = inTile(z, x, y, lon, lat);
        const h = sampleHeight(dem, u, v);
        return h === NODATA_ELEVATION_M ? null : h;
    }

    request(k, z, x, y) {
        if (this.pending.has(k)) return;
        this.pending.add(k);
        loadDem(z, x, y, { filesUrl: this.filesUrl, fetchFn: this.fetchFn })
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
