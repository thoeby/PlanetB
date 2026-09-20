// sculptpan.js — moving over the land while you are shaping it.
//
// FND.9. Shaping detaches the player: the camera has to stand still or a drag
// on the ground would be a drag on the view. So getting to the other end of a
// field meant turning Shape off, walking, and turning it back on — which drops
// the land in hand and re-reads it. The hand tool is the way over it instead
// (client/js/sculptmode.js PAN).
//
// It moves the camera and nothing else. Nothing here writes to the world.

import { rayThrough } from './buildui.js';
import { raycastGround } from './build.js';

// How close to the ground the wheel may bring you. Below this the next dab
// would be under your feet and the ground fills the window.
const MIN_AGL = 2;

// How much of the height above the ground one notch of the wheel is worth.
// A fraction, not a number of metres: a hundred metres up you want tens of
// them, and two metres up you want centimetres.
const STEP = 0.18;

// Where a ray meets the level plane the drag took hold at.
//
// The plane, not the ground: re-casting against the hillside every move makes
// the point under the pointer slide downhill as the camera moves, and the land
// runs away from the hand. A plane keeps the point you grabbed under the
// pointer, which is what a hand tool is.
function onPlane(r, y) {
    const t = (y - r.from.y) / r.dir.y;
    if (!Number.isFinite(t) || t <= 0) return null;
    return { x: r.from.x + r.dir.x * t, z: r.from.z + r.dir.z * t };
}

// How far the camera is above the ground under it, in metres. The camera's
// local y is metres off the floating origin's anchor, not off the ground, so
// both are asked of the same geodetic point (client/js/origin.js).
function above(ctx, p) {
    const g = ctx.origin.geodeticOf(p);
    return g.h - (ctx.groundAt?.(g.lon, g.lat) ?? 0);
}

export function panning(ctx) {
    let grab = null;
    const ray = (e) => {
        const rect = ctx.canvas.getBoundingClientRect();
        return rayThrough(ctx.camera, ctx.pc, e.clientX - rect.left, e.clientY - rect.top);
    };
    return {
        // What the drag took hold of: the ground under the pointer, or — off
        // the edge of any ground — the height the camera is looking down at.
        take(e) {
            const r = ray(e);
            const hit = raycastGround(ctx.terrain, r.from, r.dir);
            grab = hit ? { x: hit.x, y: hit.y, z: hit.z }
                : Object.assign(onPlane(r, 0) ?? {}, { y: 0 });
            return Number.isFinite(grab?.x) ? grab : (grab = null);
        },
        drop() { grab = null; },
        holding: () => grab !== null,
        // The point the drag took hold of, put back under the pointer.
        drag(e) {
            if (!grab) return false;
            const to = onPlane(ray(e), grab.y);
            if (!to) return false;
            const c = ctx.camera.getPosition();
            ctx.camera.setPosition(c.x + (grab.x - to.x), c.y, c.z + (grab.z - to.z));
            return true;
        },
        // In and out along the way the camera is looking, never through the
        // ground: a wheel that puts the camera inside the hill is a wheel that
        // loses the land.
        zoom(e) {
            const c = ctx.camera.getPosition();
            const step = Math.max(Math.abs(above(ctx, c)), MIN_AGL) * STEP
                * (e.deltaY > 0 ? -1 : 1);
            const f = ctx.camera.forward;
            const to = { x: c.x + f.x * step, y: c.y + f.y * step, z: c.z + f.z * step };
            if (above(ctx, to) < MIN_AGL) return false;
            ctx.camera.setPosition(to.x, to.y, to.z);
            return true;
        },
    };
}
