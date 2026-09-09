// xr.js — what changes when the world is walked in a headset: how much of it is
// loaded, and how the player moves.
//
// No PlayCanvas and no DOM: the budget and the teleport are arithmetic, so
// client/test/xr.test.js flies them without a device. play.html owns the
// session itself, because starting one is a gesture on a button and there is
// nothing to test about that without a headset to press it on.
//
// A headset draws the world twice, ninety times a second, on a mobile GPU. The
// desktop budget (25 M splats over 40 tiles, tiles.js) is three times what that
// can hold, so XR takes its own — and the streamer, which already drops the
// tiles that do not fit, needs nothing else to be told.

import { raycastGround } from './build.js';

// TASKS.md WP5.4: 8 M splats. Fewer tiles for the same reason — each one is a
// draw call per eye — and less in flight, because a stall in a headset is
// nausea rather than a slow frame.
export const XR_LIMITS = { tiles: 24, splats: 8e6, inflight: 2 };

// How far a teleport may reach, and how far above the ground it puts the eyes.
export const TELEPORT = { far: 120, eye: 1.7, step: 0.5 };

export const xrRequested = (search = '') =>
    new URLSearchParams(search).get('xr') === '1';

// Whether this browser could hold a session at all. `navigator.xr` is absent on
// every desktop browser without a runtime, which is not an error: the page says
// so and stays a page.
export async function xrSupported(nav = globalThis.navigator) {
    if (!nav?.xr?.isSessionSupported) return false;
    return nav.xr.isSessionSupported('immersive-vr').catch(() => false);
}

// Where a teleport lands: the first ground under the ray, no further than
// `far`, with the eyes put back on top of it. Null when the ray misses — the
// controller is pointing at the sky, or at ground this tab has not streamed.
export function teleportTarget(terrain, from, dir, opts = {}) {
    const { far = TELEPORT.far, eye = TELEPORT.eye, step = TELEPORT.step } = opts;
    const hit = raycastGround(terrain, from, dir, { far, step });
    if (!hit) return null;
    return { x: hit.x, y: hit.y + eye, z: hit.z, ground: hit.y };
}

// What the streamer is allowed to hold, given whether a session is running. It
// is a function rather than a constant because a session is entered and left,
// and the desktop budget comes back when it is left.
export const limitsFor = (inXr, desktop) => (inXr ? XR_LIMITS : desktop);
