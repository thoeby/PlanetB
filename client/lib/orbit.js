// orbit.js — Blueprint's camera: a point on the ground it looks at, how far
// back it stands, which way it faces and how steeply it looks down
// (PLAN-editors.md §2.1, idea 8; EDT.3).
//
// Pure arithmetic in the scene's frame (x east, y up, z south). The page keeps
// the target in degrees so a rebase does not move it (client/js/bpcamera.js).

export const PITCH_MIN = 30;
export const PITCH_MAX = 90;
export const NEAREST_M = 8;
export const FARTHEST_M = 12000;

const RAD = Math.PI / 180;

export const clampPitch = (p) => Math.min(PITCH_MAX, Math.max(PITCH_MIN, p));
export const clampDistance = (d) => Math.min(FARTHEST_M, Math.max(NEAREST_M, d));

// Which way is forward along the ground for a heading (0 north, 90 east).
export const forwardOf = (yaw) => ({ x: Math.sin(yaw * RAD), z: -Math.cos(yaw * RAD) });

/**
 * Where the camera stands and how it is turned, for a target at scene point
 * `t`: {pos, euler} with euler as PlayCanvas takes it (degrees, X then Y).
 */
export function pose({ yaw, pitch, distance }, t) {
    const p = clampPitch(pitch) * RAD;
    const f = forwardOf(yaw);
    const back = distance * Math.cos(p);
    return {
        pos: { x: t.x - f.x * back, y: t.y + distance * Math.sin(p), z: t.z - f.z * back },
        euler: [-clampPitch(pitch), -yaw, 0],
    };
}

/**
 * The wheel, towards the pointer: the point under it stays under it. `t` is
 * the target and `at` the ground under the pointer, both scene points; the
 * answer is the new target and distance.
 */
export function zoomToward(state, t, at, factor) {
    const d = clampDistance(state.distance * factor);
    const k = 1 - d / state.distance;
    const to = at ?? t;
    const along = (a, b) => a + (b - a) * k;
    return { distance: d,
        target: { x: along(t.x, to.x), y: along(t.y, to.y), z: along(t.z, to.z) } };
}

// How far back a camera with this field of view stands to see a land this
// many metres across, with a margin.
export const fitDistance = (metres, fovDeg) =>
    clampDistance((metres / 2) / Math.tan((fovDeg / 2) * RAD) * 1.15);

// The half-height an orthographic camera shows at the same framing.
export const orthoHeight = (distance, fovDeg) => distance * Math.tan((fovDeg / 2) * RAD);

// A drag of the right or middle button: turn and tilt.
export const orbitBy = (state, dx, dy) => ({ ...state,
    yaw: ((state.yaw + dx * 0.3) % 360 + 360) % 360,
    pitch: clampPitch(state.pitch + dy * 0.25) });
