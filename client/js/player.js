// player.js — the kinematic player. No physics library: the world is a
// heightmap and a list of boxes, and both are cheap to answer directly.
//
// Walking clamps to the ground sampled bilinearly from the finest loaded
// tile's height.r16; flying is free movement. Collision is a circle in the
// horizontal plane pushed out of each collider it overlaps, so the player
// slides along a wall instead of stopping dead.

import * as tm from '../lib/tilemath.js';
import { key } from './tiles.js';

export const WALK = 'walk';
export const FLY = 'fly';

const EYE_M = 1.7;
const RADIUS_M = 0.35;
const WALK_MPS = 6;
const FLY_MPS = 400;
// Shift, in the two things it means. Walking it is running, as the hint on
// screen has always said and nothing has ever done; flying it is down, which
// is the other half of Space.
const RUN = 2.5;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

// A tile's height.r16: `size` by `size` uint16 samples, row-major, north-west
// first, linear between `min` and `max` metres in the tile's own frame.
export class HeightField {
    constructor(data, meta, z, x, y) {
        this.data = data;
        this.size = meta.size;
        this.min = meta.min;
        this.max = meta.max;
        // The grid is laid over the rectangle the tile's south-west and
        // north-east corners span in its own frame — the same rectangle the
        // splats are laid on, so the ground and what you see agree. A tile is
        // really a spherical quad, and this is the same approximation the
        // generator makes.
        const b = tm.tileBbox(z, x, y);
        const o = tm.tileFrame(z, x, y, 0);
        const sw = tm.localFromLonLat(o, b.west, b.south);
        const ne = tm.localFromLonLat(o, b.east, b.north);
        this.origin = o;
        this.west = sw.x;
        this.north = ne.z;
        this.stepX = (ne.x - sw.x) / (this.size - 1);
        this.stepZ = (sw.z - ne.z) / (this.size - 1);
    }

    texel(u, v) {
        const c = Math.min(this.size - 1, Math.max(0, u));
        const r = Math.min(this.size - 1, Math.max(0, v));
        return this.min + this.data[r * this.size + c] / 65535 * (this.max - this.min);
    }

    // x, z are metres in this tile's own frame.
    at(x, z) {
        const fu = (x - this.west) / this.stepX;
        const fv = (z - this.north) / this.stepZ;
        if (fu < -0.5 || fv < -0.5 || fu > this.size - 0.5 || fv > this.size - 0.5) return null;
        const u = Math.floor(fu), v = Math.floor(fv);
        const su = fu - u, sv = fv - v;
        const a = this.texel(u, v), b = this.texel(u + 1, v);
        const c = this.texel(u, v + 1), d = this.texel(u + 1, v + 1);
        return (a * (1 - su) + b * su) * (1 - sv) + (c * (1 - su) + d * su) * sv;
    }
}

// Pushes a circle out of one box. The box is an axis-aligned extent rotated by
// `yaw` about Y, given in the same frame as the point.
//
// `from` is where the circle was before it moved. Without it the smallest
// penetration decides which way out, which is wrong the moment a step is long
// enough to land past the middle of a thin wall: the nearest face is then the
// far one and the player is pushed straight through. Knowing the direction of
// travel, the circle is instead placed against the face it came at.
function pushOut(p, box, radius, from) {
    if (p.y + 0.1 < box.center[1] - box.half[1] || p.y > box.center[1] + box.half[1]) {
        return null;
    }
    const yaw = box.yaw ?? 0;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const dx = p.x - box.center[0], dz = p.z - box.center[2];
    const lx = dx * c + dz * s, lz = -dx * s + dz * c;
    const ex = box.half[0] + radius, ez = box.half[2] + radius;
    if (Math.abs(lx) >= ex || Math.abs(lz) >= ez) return null;

    const mx = from ? (p.x - from.x) * c + (p.z - from.z) * s : 0;
    const mz = from ? -(p.x - from.x) * s + (p.z - from.z) * c : 0;
    // Candidate corrections: back out along whichever axis the circle entered.
    const cx = mx !== 0 ? -Math.sign(mx) * ex - lx : Math.sign(lx || 1) * (ex - Math.abs(lx));
    const cz = mz !== 0 ? -Math.sign(mz) * ez - lz : Math.sign(lz || 1) * (ez - Math.abs(lz));
    const useX = Math.abs(cx) <= Math.abs(cz);
    const nx = useX ? cx : 0;
    const nz = useX ? 0 : cz;
    return { x: nx * c - nz * s, z: nx * s + nz * c };
}

// Two passes: one push can drive the circle into the next box along.
export function slide(p, colliders, radius = RADIUS_M, from = null) {
    const out = { ...p };
    for (let pass = 0; pass < 2; pass++) {
        for (const box of colliders) {
            const d = pushOut(out, box, radius, from);
            if (d) { out.x += d.x; out.z += d.z; }
        }
    }
    return out;
}

// ------------------------------------------------------------------- terrain
//
// The ground under a point is the finest loaded tile that covers it. Tiles are
// found by going back through the floating origin to lon/lat and asking
// tilemath, which is exact and does not care where the anchor happens to be.

export class Terrain {
    constructor(streamer, { fetchFn = fetch, ground = null } = {}) {
        this.streamer = streamer;
        this.fetchFn = fetchFn;
        // Nothing since db/0104: the floor is what is published, and every
        // z14 tile of the ground is. Kept as an option for the tests.
        this.ground = ground;
        this.fields = new Map();
        this.colliders = new Map();
        this.wanted = new Set();
        // A tile that leaves the scene, or is swapped for a newer version,
        // takes its ground with it.
        streamer.onRelease = (k) => this.forget(k);
    }

    forget(k) {
        this.fields.delete(k);
        this.colliders.delete(k);
        this.wanted.delete(k);
    }

    tileAt(local) {
        const g = this.streamer.origin.geodeticOf(local);
        for (let i = tm.ZOOMS.length - 1; i >= 0; i--) {
            const z = tm.ZOOMS[i];
            const k = key(z, tm.tileX(g.lon, z), tm.tileY(g.lat, z));
            if (this.streamer.entries.has(k)) return k;
        }
        return null;
    }

    heightAt(local) {
        const k = this.tileAt(local);
        const field = k && this.fields.get(k);
        if (field) {
            const p = this.toTile(field, local);
            // A tile is a spherical quad and its height field is laid on the
            // rectangle its corners span, so the two disagree by metres at the
            // edges: tilemath puts you on this tile and the field answers that
            // you are off the end of it. That answer used to be the last word,
            // and a null one — walking stopped clamping and the player was
            // left standing in the air wherever they crossed a tile's border.
            // It is one surface saying it cannot see this point, not the world
            // saying there is no ground here.
            const h = field.at(p.x, p.z);
            if (h !== null && h !== undefined) return h;
        }
        if (k) this.request(k);
        // A published tile's own height.r16 first, the world's ground under
        // it — everywhere the coverage reaches, rendered or not (SPEC §0.1).
        //
        // The ground answers in metres above sea level, because that is what a
        // DEM is; everything in the scene is metres from the anchor, and the
        // anchor moves under the camera as you travel (client/js/origin.js).
        // Taking one for the other put a player who had walked far enough to
        // rebase twice their own height in the air, and only when the tile
        // they were standing on had not published its height.r16 — which is
        // most of the world.
        const g = this.streamer.origin.geodeticOf(local);
        const metres = this.ground?.heightAt(g.lon, g.lat);
        if (metres === null || metres === undefined) return null;
        return this.streamer.origin.localOf({ lon: g.lon, lat: g.lat, h: metres }).y;
    }

    // The point, expressed in the tile's own frame rather than the anchor's.
    toTile(field, local) {
        const g = this.streamer.origin.geodeticOf(local);
        return tm.localFromLonLat(field.origin, g.lon, g.lat, g.h);
    }

    collidersAt(local) {
        const k = this.tileAt(local);
        if (!k) return [];
        const boxes = this.colliders.get(k);
        if (!boxes) { this.request(k); return []; }
        const field = this.fields.get(k);
        return field ? boxes.map((b) => this.toAnchor(field, b)) : [];
    }

    // Colliders are stored in the tile's frame; the player lives in the
    // anchor's. Over one tile the two differ by a translation to within
    // millimetres, so only the centre is moved.
    toAnchor(field, box) {
        const g = tm.lonLatFromLocal(field.origin, {
            x: box.center[0], y: box.center[1], z: box.center[2],
        });
        const p = this.streamer.origin.localOf(g);
        return { ...box, center: [p.x, p.y, p.z] };
    }

    request(k) {
        if (this.wanted.has(k)) return;
        this.wanted.add(k);
        const entry = this.streamer.entries.get(k);
        const man = entry?.row?.manifest;
        const { z, x, y } = entry ? entry.row : {};
        if (!man?.height || !man?.colliders) return;
        const base = `${this.streamer.filesUrl}/tiles/${z}/${x}/${y}`;
        const keep = () => this.wanted.has(k);
        this.fetchFn(`${base}/${man.height.sha256}.r16`)
            .then((r) => (r.ok ? r.arrayBuffer() : null))
            .then((buf) => {
                if (!buf || !keep()) return;
                this.fields.set(k, new HeightField(new Uint16Array(buf), man.height, z, x, y));
            })
            .catch(() => this.wanted.delete(k));
        this.fetchFn(`${base}/${man.colliders.sha256}.json`)
            .then((r) => (r.ok ? r.json() : null))
            .then((json) => { if (json && keep()) this.colliders.set(k, json.boxes ?? []); })
            .catch(() => this.wanted.delete(k));
    }
}

// -------------------------------------------------------------------- player

// Movement keys are listened for on the window, so a field on the same page
// gets W, A, S, D, Space and Shift swallowed by preventDefault and F silently
// switching walk/fly. Typing an email into a form is not walking.
function typing(target) {
    if (!target || target === document.body) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        || target.isContentEditable === true;
}

const KEYS = {
    KeyW: 'fwd', KeyS: 'back', KeyA: 'left', KeyD: 'right',
    ArrowUp: 'fwd', ArrowDown: 'back', ArrowLeft: 'left', ArrowRight: 'right',
    Space: 'up', ShiftLeft: 'shift', ShiftRight: 'shift',
};

export class Player {
    constructor(terrain, opts = {}) {
        this.terrain = terrain;
        this.mode = opts.mode ?? WALK;
        this.eye = opts.eye ?? EYE_M;
        this.radius = opts.radius ?? RADIUS_M;
        this.walkSpeed = opts.walkSpeed ?? WALK_MPS;
        this.flySpeed = opts.flySpeed ?? FLY_MPS;
        this.position = { x: 0, y: this.eye, z: 0 };
        this.yaw = 0;
        this.pitch = 0;
        this.held = new Set();
        this.grounded = false;
    }

    // The way you are facing, clockwise from north, in degrees: what a compass
    // and a map put a needle at. Not the same number as `yaw`, and not its
    // negation by accident — yaw turns about +Y in a frame where north is -Z
    // (client/lib/tilemath.js localFromLonLat is ENU with z south), so forward
    // at yaw θ is east −sin θ, north cos θ, and that is a heading of −θ.
    //
    // Reporting yaw as a heading mirrored both instruments about north: at yaw
    // 90° the player walks west and the compass said east, and turning right
    // on screen turned the map's cone left.
    get heading() {
        return (((-this.yaw * 180) / Math.PI) % 360 + 360) % 360;
    }

    set heading(deg) {
        this.yaw = (-deg * Math.PI) / 180;
    }

    toggleMode() {
        this.mode = this.mode === WALK ? FLY : WALK;
        // Told rather than watched for: the page has to say which way you are
        // moving, and the two modes are two sets of controls.
        this.onMode?.(this.mode);
        return this.mode;
    }

    look(dx, dy, sensitivity = 0.0022) {
        this.yaw -= dx * sensitivity;
        this.pitch = Math.min(PITCH_LIMIT,
            Math.max(-PITCH_LIMIT, this.pitch - dy * sensitivity));
    }

    // Movement wanted this frame, in metres, before the world has its say.
    //
    // Walking is on the plane: you are on the ground and the ground decides
    // your height. Flying goes where you are looking — pitch and all — because
    // flying over a world at a fixed height while pointing down at it is how
    // you never arrive anywhere. Space and Shift are still straight up and
    // straight down, for when what you want is height rather than a direction.
    intent(dt) {
        const flying = this.mode === FLY;
        const fast = !flying && this.held.has('shift') ? RUN : 1;
        const speed = (flying ? this.flySpeed : this.walkSpeed) * fast * dt;
        const f = (this.held.has('fwd') ? 1 : 0) - (this.held.has('back') ? 1 : 0);
        const r = (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0);
        const u = (this.held.has('up') ? 1 : 0)
            - (flying && this.held.has('shift') ? 1 : 0);
        const len = Math.hypot(f, r) || 1;
        const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
        const cp = flying ? Math.cos(this.pitch) : 1;
        const sp = flying ? Math.sin(this.pitch) : 0;
        // Z south, so forward at yaw 0 is -Z (north).
        return {
            x: (f / len * -sy * cp + r / len * cy) * speed,
            y: (flying ? f / len * sp + u : 0) * speed,
            z: (f / len * -cy * cp - r / len * sy) * speed,
        };
    }

    update(dt) {
        const d = this.intent(dt);
        let next = {
            x: this.position.x + d.x,
            y: this.position.y + d.y,
            z: this.position.z + d.z,
        };
        const boxes = this.terrain?.collidersAt(next) ?? [];
        // Walk the move in pieces no longer than the player is wide, or a fast
        // enough step hops clean over a thin wall and no push-out can help.
        if (boxes.length) {
            const steps = Math.min(64,
                Math.max(1, Math.ceil(Math.hypot(d.x, d.z) / this.radius)));
            let p = { ...this.position };
            for (let i = 0; i < steps; i++) {
                const q = {
                    x: p.x + d.x / steps, y: p.y + d.y / steps, z: p.z + d.z / steps,
                };
                p = { ...q, ...slide(q, boxes, this.radius, p) };
            }
            next = p;
        }
        const ground = this.terrain?.heightAt(next) ?? null;
        this.grounded = ground !== null;
        if (this.mode === WALK && ground !== null) next.y = ground + this.eye;
        this.position = next;
        return this.position;
    }

    // Pointer lock plus key state. Nothing here decides anything about the
    // world; update() does, and the tests drive it directly.
    attach(canvas) {
        this.canvas = canvas;
        this.onKeyDown = (e) => {
            if (typing(e.target)) return;
            if (e.code === 'KeyF') this.toggleMode();
            const k = KEYS[e.code];
            if (k) { this.held.add(k); e.preventDefault(); }
        };
        this.onKeyUp = (e) => { if (!typing(e.target)) this.held.delete(KEYS[e.code]); };
        this.onMove = (e) => {
            if (document.pointerLockElement === canvas) this.look(e.movementX, e.movementY);
        };
        this.onClick = () => canvas.requestPointerLock?.();
        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
        window.addEventListener('mousemove', this.onMove);
        canvas.addEventListener('click', this.onClick);
    }

    detach() {
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('mousemove', this.onMove);
        this.canvas?.removeEventListener('click', this.onClick);
        this.held.clear();
    }
}
