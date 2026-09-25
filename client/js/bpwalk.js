// bpwalk.js — Walk it (EDT.16, PLAN-editors.md idea 25): the clay camera
// drops to eye height at the node of a line nearest where it was looking and
// follows the line at walking pace, looking ahead along it. Esc hands the
// Blueprint camera back where it was.

import { frameAt } from '../lib/spline.js';

export const EYE_M = 1.7;
export const PACE_MS = 1.4;
// How far ahead along the line the walker looks.
const AHEAD_M = 8;

export class WalkAlong {
    /**
     * `points` the line's curve in degrees, `from` {lon, lat} the point the
     * walk starts nearest to.
     */
    constructor(bp, points, from) {
        this.bp = bp;
        this.f = frameAt(points[0].lon, points[0].lat);
        this.xz = points.map((p) => this.f.toXZ(p.lon, p.lat));
        this.along = [0];
        for (let i = 1; i < this.xz.length; i++) {
            const [a, b] = [this.xz[i - 1], this.xz[i]];
            this.along.push(this.along[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
        }
        const here = this.f.toXZ(from.lon, from.lat);
        let best = 0;
        this.xz.forEach((p, i) => {
            const d = Math.hypot(p[0] - here[0], p[1] - here[1]);
            const b = this.xz[best];
            if (d < Math.hypot(b[0] - here[0], b[1] - here[1])) best = i;
        });
        this.at = this.along[best];
        this.dir = best === this.xz.length - 1 ? -1 : 1;
        this.done = false;
    }

    get length() { return this.along.at(-1); }

    // The point `s` metres along the line, in degrees.
    point(s) {
        const t = Math.max(0, Math.min(this.length, s));
        let i = 1;
        while (i < this.along.length - 1 && this.along[i] < t) i += 1;
        const a = this.xz[i - 1];
        const b = this.xz[i];
        const k = (t - this.along[i - 1]) / ((this.along[i] - this.along[i - 1]) || 1);
        return this.f.toLonLat([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
    }

    // One frame of walking: the camera at eye height, looking ahead.
    step(camera, dt) {
        this.at += this.dir * PACE_MS * dt;
        if (this.at <= 0 || this.at >= this.length) this.done = true;
        const p = this.point(this.at);
        const ahead = this.point(this.at + this.dir * AHEAD_M);
        const eye = this.bp.toScene(p.lon, p.lat, (this.bp.heightAt(p.lon, p.lat) ?? 0) + EYE_M);
        const look = this.bp.toScene(ahead.lon, ahead.lat,
            (this.bp.heightAt(ahead.lon, ahead.lat) ?? 0) + EYE_M * 0.8);
        camera.setPosition(eye.x, eye.y, eye.z);
        camera.lookAt(look);
        camera.camera.nearClip = 0.2;
        return p;
    }
}
