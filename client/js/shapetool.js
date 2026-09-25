// shapetool.js — Shape's hand on the Blueprint clay (PLAN-editors.md §2.2).
//
// What client/js/bpmode.js asks of a surface: which tool is in hand, what a
// press, a drag and a release do with it, what to add to the words at the
// pointer, and what to draw every frame — the brush on the ground where the
// pointer is, before any drag, red off the land.
//
// A stroke outside the land changes nothing and says so. That is a courtesy,
// not the rule: the rule is row-level security on the save (Invariant 6) and
// the compiler ignoring every cell outside the land whatever was written.

import { dab } from './sculptbrush.js';
import { drawPath, drawRing } from './bpdraw.js';

export const REFUSED = 'You can only shape your own land';

/**
 * `state` is the panel's (brush, size, strength, shaping, line…); `acts` is
 * {say, hover, shaped(rect), levelTo(), ground(lon, lat)}.
 */
export function shapeSurface(bp, app, pc, state, acts) {
    const paintAt = (g) => {
        if (!state.shaping || !g) return;
        if (!state.shaping.inside(g.lon, g.lat)) {
            state.refused = true;
            acts.say(REFUSED, true);
            return;
        }
        dab(state.shaping, g.lon, g.lat, { brush: state.brush, size: state.size,
            strength: state.strength, ground: acts.ground,
            target: state.brush === 'level' ? acts.levelTo() : undefined });
        acts.shaped(around(g, state.size));
        if (state.refused) { state.refused = false; acts.say(''); } else acts.hover();
    };
    return {
        tool: () => state.brush,
        down(g) {
            if (!g) { acts.say('no ground under the pointer', true); return; }
            state.at = g;
            if (state.brush === 'line') {
                state.line = [...(state.line ?? []), g];
                acts.hover();
                return;
            }
            state.painting = true;
            state.strokeFrom = state.shaping?.at(g.lon, g.lat) ?? 0;
            state.shaping?.begin();
            paintAt(g);
        },
        move(g) {
            if (g) state.at = g;
            state.inside = g ? Boolean(state.shaping?.inside(g.lon, g.lat)) : null;
            if (state.painting && g) paintAt(g);
        },
        up() {
            state.painting = false;
            state.shaping?.end();
            acts.say();
        },
        hover(g) {
            if (g) state.at = g;
            state.inside = g ? Boolean(state.shaping?.inside(g.lon, g.lat)) : null;
        },
        // This stroke's change under the pointer, for the numbers box.
        describe(g, base) {
            if (!g || base.lost || !state.painting) return base;
            return { ...base, stroke: (state.shaping?.at(g.lon, g.lat) ?? 0)
                - (state.strokeFrom ?? 0) };
        },
        draw: () => drawBrush(bp, app, pc, state),
    };
}

// The rectangle a dab can have touched, in degrees, for rebuild(rect).
export function around(g, size) {
    const r = size / 2 + 1;
    const dLon = r / (111320 * Math.cos(g.lat * Math.PI / 180));
    const dLat = r / 110540;
    return [g.lon - dLon, g.lat - dLat, g.lon + dLon, g.lat + dLat];
}

// The brush where the pointer is: its ring, and the inner ring where it is at
// full strength. Blue on the land, red off it; none for the hand or the section.
function drawBrush(bp, app, pc, state) {
    if (state.brush === 'line') {
        if (state.line?.length) drawPath(bp, app, pc, state.line, new pc.Color(1, 0.85, 0.35));
        return;
    }
    if (!state.at || state.brush === 'pan' || state.brush === 'section') return;
    const tone = state.inside === false ? new pc.Color(1, 0.35, 0.3)
        : new pc.Color(0.3, 0.85, 1);
    drawRing(bp, app, state.at, Math.max(1, state.size) / 2, tone);
    drawRing(bp, app, state.at, Math.max(1, state.size) / 4, tone);
}
