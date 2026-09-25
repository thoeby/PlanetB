// bpcamera.js — the camera while Blueprint is open (EDT.3): it orbits a point
// on the ground instead of standing in the player's eyes.
//
// Wheel zooms to the pointer, the middle or right button drags an orbit,
// pitch stays between 30° and straight down, O swaps perspective and
// orthographic, and Zoom to land frames the land. The walk camera is detached
// on the way in, as Shape always did (client/js/sculptui.js), and handed back
// on the way out exactly where the player left it.

import { fitDistance, orbitBy, orthoHeight, pose, zoomToward } from '../lib/orbit.js';
import { pickGround } from './blueprint.js';

const FOV = 45;

export class BlueprintCamera {
    constructor(bp, ctx) {
        this.bp = bp;
        this.ctx = ctx;     // {camera, canvas, pc, player, setDriving}
        this.state = { target: null, distance: 400, yaw: 0, pitch: 60, ortho: false };
        this.on = false;
        this.handlers = this.makeHandlers();
    }

    // Blueprint opened: the player lets go of the camera, and it frames the land.
    enter() {
        if (this.on) return;
        this.on = true;
        this.was = { yaw: this.ctx.player?.heading ?? 0 };
        this.ctx.setDriving?.(false);
        this.ctx.player?.detach();
        document.exitPointerLock?.();
        for (const [name, fn, opts] of this.handlers) {
            (name.startsWith('key') ? window : this.ctx.canvas).addEventListener(name, fn, opts);
        }
        this.state.yaw = Number.isFinite(this.was.yaw) ? this.was.yaw : 0;
        this.toLand();
    }

    leave() {
        if (!this.on) return;
        this.on = false;
        for (const [name, fn] of this.handlers) {
            (name.startsWith('key') ? window : this.ctx.canvas).removeEventListener(name, fn);
        }
        this.setOrtho(false);
        this.ctx.player?.attach(this.ctx.canvas);
        this.ctx.setDriving?.(true);
    }

    // Frames the whole land, looking down at sixty degrees.
    toLand() {
        const L = this.bp.L;
        if (!L) return;
        const wide = Math.max((L.cols - 1) * L.dx, (L.rows - 1) * L.dz);
        this.state.target = { lon: L.lon0, lat: L.lat0,
            h: this.bp.heightAt(L.lon0, L.lat0) ?? this.bp.h0 };
        this.state.distance = fitDistance(wide, FOV) * 1.2;
        this.state.pitch = 60;
        this.update();
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
    update() {
        if (!this.on || !this.state.target || !this.bp.active) return;
        const got = pose(this.state, this.targetScene());
        const cam = this.ctx.camera;
        cam.setPosition(got.pos.x, got.pos.y, got.pos.z);
        cam.setEulerAngles(got.euler[0], got.euler[1], got.euler[2]);
        if (this.state.ortho) cam.camera.orthoHeight = orthoHeight(this.state.distance, FOV);
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
                orbiting = { x: e.clientX, y: e.clientY };
            }],
            ['pointermove', (e) => {
                if (!orbiting) return;
                this.state = { ...this.state, ...orbitBy(this.state, e.clientX - orbiting.x,
                    e.clientY - orbiting.y) };
                orbiting = { x: e.clientX, y: e.clientY };
                this.update();
            }],
            ['pointerup', () => { orbiting = null; }],
            ['contextmenu', (e) => e.preventDefault()],
            ['keydown', (e) => {
                if (e.target?.closest?.('input, select, textarea, [contenteditable]')) return;
                if (e.key === 'o' || e.key === 'O') this.setOrtho(!this.state.ortho);
            }],
        ];
    }
}
