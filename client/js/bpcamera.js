// bpcamera.js — the camera while Blueprint is open (EDT.3): it orbits a point
// on the ground instead of standing in the player's eyes.
//
// Wheel zooms to the pointer, the middle or right button drags an orbit,
// WASD flies over the land and Q/E (or Space) go down and up — always, with
// no pointer lock and nothing to switch — pitch stays between 30° and straight
// down, O swaps perspective and orthographic, and Zoom to land frames the
// land. The walk camera is let go of the moment a surface asks for the clay,
// before the ground has even loaded, and handed back on the way out exactly
// where the player left it.

import { clampDistance, orbitBy, orthoHeight, pose, zoomToward } from '../lib/orbit.js';
import { pickGround } from './blueprint.js';
import { WalkAlong } from './bpwalk.js';

const FOV = 45;
// WASD, as a share of the distance to the ground per second; Q/E, how fast
// the distance grows or shrinks.
const FLY_PER_S = 0.8;
const CLIMB_PER_S = 1.2;
const FLY_KEYS = { KeyW: [0, 1], KeyS: [0, -1], KeyA: [-1, 0], KeyD: [1, 0] };
const CLIMB_KEYS = { KeyE: 1, Space: 1, KeyQ: -1 };
// Past this distance only the ten-metre contours are drawn.
const FAR_CONTOURS_M = 1200;

export class BlueprintCamera {
    constructor(bp, ctx) {
        this.bp = bp;
        this.ctx = ctx;     // {camera, canvas, pc, player, setDriving}
        this.state = { target: null, distance: 400, yaw: 0, pitch: 60, ortho: false };
        this.on = false;
        this.keys = new Set();
        this.handlers = this.makeHandlers();
    }

    // A surface is opening the clay: the player lets go now — a click while the
    // ground loads must not lock the pointer and send the view flying.
    hold() {
        if (this.holding) return;
        this.holding = true;
        this.was = { yaw: this.ctx.player?.heading ?? 0,
            near: this.ctx.camera.camera.nearClip };
        this.ctx.setDriving?.(false);
        this.ctx.player?.detach();
        document.exitPointerLock?.();
    }

    // Blueprint opened: it frames the land.
    enter() {
        if (this.on) return;
        this.hold();
        this.on = true;
        for (const [name, fn, opts] of this.handlers) {
            (name.startsWith('key') || name === 'blur' ? window : this.ctx.canvas)
                .addEventListener(name, fn, opts);
        }
        this.state.yaw = Number.isFinite(this.was.yaw) ? this.was.yaw : 0;
        this.toLand();
    }

    leave() {
        if (!this.on && !this.holding) return;
        this.on = false;
        this.holding = false;
        this.keys.clear();
        for (const [name, fn] of this.handlers) {
            (name.startsWith('key') || name === 'blur' ? window : this.ctx.canvas)
                .removeEventListener(name, fn);
        }
        this.setOrtho(false);
        this.ctx.camera.camera.nearClip = this.was?.near ?? 0.3;
        this.ctx.player?.attach(this.ctx.canvas);
        this.ctx.setDriving?.(true);
    }

    // Frames the whole land, looking down at sixty degrees.
    toLand() {
        const L = this.bp.L;
        if (!L) return;
        this.state.target = { lon: L.lon0, lat: L.lat0,
            h: this.bp.heightAt(L.lon0, L.lat0) ?? this.bp.h0 };
        // Framed in the part of the view the panel and the card leave open:
        // its width by the horizontal field, its depth by the vertical one.
        const { left = 0, right = 0 } = this.ctx.inset?.() ?? {};
        const w = this.ctx.canvas.clientWidth || 1;
        const h = this.ctx.canvas.clientHeight || 1;
        const open = Math.max(0.3, (w - left - right) / w);
        const half = Math.tan((FOV / 2) * Math.PI / 180);
        const across = (L.cols - 1) * L.dx;
        const deep = (L.rows - 1) * L.dz;
        this.state.distance = clampDistance(1.15 * Math.max(across / 2 / (half * (w / h) * open),
            deep / 2 / half));
        this.state.pitch = 60;
        this.aside();
        this.update();
    }

    // The panel down the left and the card on the right cover part of the
    // view, so the land is framed in what is left of it: the target moves by
    // half the difference, in metres at the target's distance.
    aside() {
        const { left = 0, right = 0 } = this.ctx.inset?.() ?? {};
        const w = this.ctx.canvas.clientWidth || 1;
        if (left + right >= w) return;
        const h = this.ctx.canvas.clientHeight || 1;
        const across = 2 * this.state.distance * Math.tan((FOV / 2) * Math.PI / 180) * (w / h);
        const shift = ((left - right) / 2) / w * across;
        const yaw = this.state.yaw * Math.PI / 180;
        const t = this.state.target;
        const mLon = 111320 * Math.cos(t.lat * Math.PI / 180);
        this.state.target = { ...t, lon: t.lon - Math.cos(yaw) * shift / mLon,
            lat: t.lat + Math.sin(yaw) * shift / 110540 };
    }

    setOrtho(on) {
        this.state.ortho = on;
        const cam = this.ctx.camera.camera;
        const { pc } = this.ctx;
        cam.projection = on ? pc.PROJECTION_ORTHOGRAPHIC : pc.PROJECTION_PERSPECTIVE;
        this.update();
        // The corner card says which it is (client/js/bpside.js).
        this.bp.tell(null);
    }

    targetScene() {
        const t = this.state.target;
        return this.bp.toScene(t.lon, t.lat, t.h);
    }

    // Every frame while open: the camera where the state says.
    // Walk it: along a line at eye height until it ends or Esc (bpwalk.js).
    walk(points) {
        if (points.length < 2) return null;
        this.walking = new WalkAlong(this.bp, points, this.state.target);
        return this.walking;
    }

    stopWalking() {
        const was = Boolean(this.walking);
        this.walking = null;
        this.update();
        return was;
    }

    update(dt = 0) {
        if (!this.on || !this.state.target || !this.bp.active) return;
        if (this.walking) {
            this.walking.step(this.ctx.camera, dt);
            return;
        }
        if (this.keys.size && dt > 0) this.fly(Math.min(dt, 0.1));
        const got = pose(this.state, this.targetScene());
        const cam = this.ctx.camera;
        cam.setPosition(got.pos.x, got.pos.y, got.pos.z);
        cam.setEulerAngles(got.euler[0], got.euler[1], got.euler[2]);
        // The walk camera's near plane is a hand's breadth; from a kilometre
        // up that spends the depth buffer on nothing, and the ring half a
        // metre under the land showed through it in specks.
        cam.camera.nearClip = Math.min(50, Math.max(0.5, this.state.distance / 100));
        if (this.state.ortho) cam.camera.orthoHeight = orthoHeight(this.state.distance, FOV);
        // From far off, two-metre contours are a moiré, not a map: only the
        // bold ones are drawn until the camera comes closer.
        const far = this.state.distance > FAR_CONTOURS_M;
        if (far !== this.bp.far) {
            this.bp.far = far;
            this.bp.relines();
        }
    }

    // WASD over the land, along the way the camera faces; Q/E the height.
    fly(dt) {
        let [x, y, climb] = [0, 0, 0];
        for (const code of this.keys) {
            if (FLY_KEYS[code]) { x += FLY_KEYS[code][0]; y += FLY_KEYS[code][1]; }
            climb += CLIMB_KEYS[code] ?? 0;
        }
        const step = this.state.distance * FLY_PER_S * dt;
        const a = this.state.yaw * Math.PI / 180;
        const east = (Math.sin(a) * y + Math.cos(a) * x) * step;
        const north = (Math.cos(a) * y - Math.sin(a) * x) * step;
        const t = this.state.target;
        this.state.target = { ...t, lon: t.lon + east / (111320 * Math.cos(t.lat * Math.PI / 180)),
            lat: t.lat + north / 110540 };
        if (climb) {
            this.state.distance = clampDistance(this.state.distance
                * Math.exp(climb * CLIMB_PER_S * dt));
        }
    }

    // The ground point under a pixel.
    under(e) {
        const r = this.ctx.canvas.getBoundingClientRect();
        return pickGround(this.bp, this.ctx.camera, e.clientX - r.left, e.clientY - r.top);
    }

    zoom(e) {
        const t = this.targetScene();
        const g = this.under(e);
        const at = g ? this.bp.toScene(g.lon, g.lat, g.h) : null;
        const got = zoomToward(this.state, t, at, e.deltaY > 0 ? 1.18 : 1 / 1.18);
        const geo = this.bp.toGeo(got.target);
        this.state.distance = got.distance;
        this.state.target = { lon: geo.lon, lat: geo.lat, h: geo.h };
        this.update();
    }

    // The hand: the ground point taken hold of stays under the pointer.
    grab(e) { this.held = this.under(e); return Boolean(this.held); }

    drag(e) {
        if (!this.held) return false;
        const now = this.under(e);
        if (!now) return false;
        const t = this.state.target;
        this.state.target = { lon: t.lon + (this.held.lon - now.lon),
            lat: t.lat + (this.held.lat - now.lat), h: t.h };
        this.update();
        return true;
    }

    drop() { this.held = null; }

    makeHandlers() {
        let orbiting = null;
        return [
            ['wheel', (e) => { e.preventDefault(); this.zoom(e); }, { passive: false }],
            ['pointerdown', (e) => {
                if (e.button !== 1 && e.button !== 2) return;
                e.preventDefault();
                orbiting = { x: e.clientX, y: e.clientY, from: [e.clientX, e.clientY] };
            }],
            ['pointermove', (e) => {
                if (!orbiting) return;
                this.state = { ...this.state, ...orbitBy(this.state, e.clientX - orbiting.x,
                    e.clientY - orbiting.y) };
                orbiting = { ...orbiting, x: e.clientX, y: e.clientY };
                this.update();
            }],
            // A right press that did not move is a click: the surface's
            // context menu (client/js/lineedit.js), not an orbit.
            ['pointerup', (e) => {
                const was = orbiting;
                orbiting = null;
                if (was && e.button === 2
                    && Math.hypot(e.clientX - was.from[0], e.clientY - was.from[1]) < 4) {
                    this.ctx.onContext?.(e);
                }
            }],
            ['contextmenu', (e) => e.preventDefault()],
            ['keydown', (e) => {
                if (e.target?.closest?.('input, select, textarea, [contenteditable]')) return;
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                if (FLY_KEYS[e.code] || CLIMB_KEYS[e.code]) {
                    e.preventDefault();
                    this.keys.add(e.code);
                    return;
                }
                if (e.key === 'o' || e.key === 'O') this.setOrtho(!this.state.ortho);
            }],
            ['keyup', (e) => { this.keys.delete(e.code); }],
            ['blur', () => this.keys.clear()],
        ];
    }
}
