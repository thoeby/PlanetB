// origin.js — the floating origin.
//
// Tiles are metres in a local ENU frame (ARCHITECTURE §2) and entity positions
// are float32, which holds about 0.5 m of precision at 10^7 m. Rather than let
// the camera wander away from 0, the whole scene is re-expressed around a new
// anchor whenever the camera drifts more than 5 km from the current one.
//
// Rebasing does not translate anything. Two ENU frames 5 km apart differ by a
// small rotation as well as an offset, so every position is recomputed from its
// geodetic original — the one number that never loses precision.

import { localFromLonLat, lonLatFromLocal } from '../lib/tilemath.js';

const REBASE_M = 5000;

export class FloatingOrigin {
    constructor(anchor, { rebaseMetres = REBASE_M } = {}) {
        this.anchor = { lon: anchor.lon, lat: anchor.lat, h: anchor.h ?? 0 };
        this.rebaseMetres = rebaseMetres;
        this.rebases = 0;
    }

    // Where a geodetic point sits in the current frame.
    localOf(p) {
        return localFromLonLat(this.anchor, p.lon, p.lat, p.h ?? 0);
    }

    // The inverse: what a local position is on the globe.
    geodeticOf(local) {
        return lonLatFromLocal(this.anchor, local);
    }

    // Distance of a local position from the anchor, ignoring height: a camera
    // climbing straight up loses no precision worth rebasing for.
    drift(local) {
        return Math.hypot(local.x, local.z);
    }

    needsRebase(local) {
        return this.drift(local) > this.rebaseMetres;
    }

    // Moves the anchor under the camera and returns the camera's position in
    // the new frame, or null if no rebase was due. Everything else placed in
    // the old frame must be replaced with localOf() of its own geodetic origin.
    rebase(local) {
        if (!this.needsRebase(local)) return null;
        const g = this.geodeticOf(local);
        this.anchor = { lon: g.lon, lat: g.lat, h: g.h };
        this.rebases++;
        return this.localOf(g);
    }
}
