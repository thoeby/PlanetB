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

import { bandAt, bearing, dab, fallPlane } from './sculptbrush.js';
import { drawPath, drawRing } from './bpdraw.js';
import { BrushDisc } from './brushdisc.js';

export const REFUSED = 'You can only shape your own land';

// The press itself is a dab, so a click without a hold still moves the ground.
const FIRST_DAB_S = 1 / 30;
// A frame that took longer than this (a tab in the background) is not a
// reason for one dab to raise a metre.
const MAX_DT_S = 0.1;

/**
 * `state` is the panel's (brush, size, strength, shaping, line…); `acts` is
 * {say, hover, shaped(rect), levelTo(), ground(lon, lat)}.
 */
export function shapeSurface(bp, app, pc, state, acts) {
    const disc = new BrushDisc(bp);
    const paintAt = (g, dt) => paint(state, acts, g, dt);
    return {
        tool: () => state.brush,
        down(g, e) {
            if (!g) { acts.say('no ground under the pointer', true); return; }
            state.at = g;
            state.invert = Boolean(e?.shiftKey);
            if (special(state, acts, g, e)) return;
            state.painting = true;
            state.strokeFrom = state.shaping?.at(g.lon, g.lat) ?? 0;
            // Flatten's plane goes through where the stroke began.
            state.plane = state.brush === 'flatten'
                ? fallPlane({ ...g, h: bp.heightAt(g.lon, g.lat) }, state.fall, state.dir)
                : null;
            state.strokeAt = g;
            state.shaping?.begin({ brush: state.brush, size: state.size,
                strength: state.strength, invert: state.invert });
            paintAt(g, FIRST_DAB_S);
        },
        move(g, e) {
            if (g) state.at = g;
            state.invert = Boolean(e?.shiftKey);
            state.inside = g ? Boolean(state.shaping?.inside(g.lon, g.lat)) : null;
            if (state.turning && g) acts.turn(bearing(state.turning, g));
        },
        // Every frame the pointer is held down, moving or not: holding still
        // keeps raising (PLAN-editors idea 9).
        tick(dt) {
            if (state.painting && state.at) paintAt(state.at, Math.min(dt, MAX_DT_S));
        },
        up() {
            state.turning = null;
            if (state.painting && state.shaping?.stroke && state.strokeAt) {
                // How far the stroke moved the ground where it began, for
                // the history (EDT.9).
                state.shaping.stroke.note.delta = state.shaping.at(state.strokeAt.lon,
                    state.strokeAt.lat) - (state.strokeFrom ?? 0);
            }
            state.painting = false;
            state.shaping?.end();
            bp.settle();
            acts.say();
        },
        hover(g) {
            if (g) state.at = g;
            state.inside = g ? Boolean(state.shaping?.inside(g.lon, g.lat)) : null;
        },
        // This stroke's change under the pointer, and whether the brush is
        // in the band where it fades, for the words at the pointer.
        describe(g, base) {
            if (!g || base.lost) return base;
            const lim = state.limit;
            const out = { ...base, limit: lim, band: base.inside && state.blend
                && bandAt(state.shaping?.rings ?? [], g.lon, g.lat) < 1,
            over: Boolean(lim) && (base.off >= lim.up - 0.005 || base.off <= -lim.down + 0.005
                || (state.painting && state.over)) };
            if (state.painting) {
                out.stroke = (state.shaping?.at(g.lon, g.lat) ?? 0) - (state.strokeFrom ?? 0);
            }
            return out;
        },
        draw: () => drawBrush(bp, app, pc, state, disc),
    };
}

// A press that is not a stroke: a corner of the bed's line, Alt picking
// Level's height off the ground, Ctrl turning Flatten's arrow. True if so.
function special(state, acts, g, e) {
    if (state.brush === 'line') {
        state.line = [...(state.line ?? []), g];
        acts.hover();
        return true;
    }
    if (state.brush === 'level' && e?.altKey) {
        acts.take(g);
        return true;
    }
    if (state.brush === 'flatten' && (e?.ctrlKey || e?.metaKey)) {
        state.turning = g;
        return true;
    }
    return false;
}

// One dab where the brush is, for `dt` seconds of holding it there.
function paint(state, acts, g, dt) {
    if (!state.shaping || !g) return;
    if (!state.shaping.inside(g.lon, g.lat)) {
        state.refused = true;
        acts.say(REFUSED, true);
        return;
    }
    dab(state.shaping, g.lon, g.lat, { brush: state.brush, size: state.size,
        strength: state.strength, dt, soft: state.soft, curve: state.curve,
        shape: state.brush === 'raise' ? state.shape : 'circle', invert: state.invert,
        blend: state.blend, ground: acts.ground, plane: state.plane, limit: state.limit,
        target: state.brush === 'level' ? acts.levelTo() : undefined });
    state.over = Boolean(state.shaping.over);
    acts.shaped(around(g, state.size));
    if (state.refused) { state.refused = false; acts.say(''); } else acts.hover();
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
function drawBrush(bp, app, pc, state, disc) {
    if (state.brush === 'line') {
        disc.hide();
        if (state.line?.length) drawPath(bp, app, pc, state.line, new pc.Color(1, 0.85, 0.35));
        return;
    }
    if (!state.at || state.brush === 'pan' || state.brush === 'section') { disc.hide(); return; }
    // Red off the land, amber where the operator's limit stopped it.
    const rgb = state.inside === false ? [1, 0.35, 0.3]
        : state.over && state.painting ? [1, 0.75, 0.2] : [0.3, 0.85, 1];
    const tone = new pc.Color(...rgb);
    const square = state.shape === 'square' && state.brush === 'raise';
    const r = Math.max(1, state.size) / 2;
    // What the brush will do, on the ground: its falloff as a shaded disc.
    disc.show(state.at, r, { soft: state.soft ?? 0.6, curve: state.curve, square }, rgb);
    drawRing(bp, app, state.at, r, tone, square);
    // The core, where it is at full strength.
    drawRing(bp, app, state.at, r * (1 - (state.soft ?? 0.6)), tone, square);
    if (state.brush === 'flatten' && state.fall > 0) drawArrow(bp, app, pc, state);
    const sheet = state.brush === 'level' ? () => state.target
        : state.painting && state.plane ? state.plane : null;
    if (sheet && (state.painting || state.brush === 'level')) {
        drawSheet(bp, app, pc, state.at, r, sheet);
    }
}

// Which way Flatten's plane falls: an arrow on the ground from the pointer.
function drawArrow(bp, app, pc, state) {
    const len = Math.max(4, state.size * 0.6);
    const at = state.at;
    const tip = step(at, state.dir, len);
    const colour = new pc.Color(1, 0.8, 0.3);
    drawPath(bp, app, pc, [at, tip], colour);
    drawPath(bp, app, pc, [step(tip, state.dir + 150, len / 4), tip,
        step(tip, state.dir - 150, len / 4)], colour);
}

// The height Level or Flatten aims at, as a translucent-looking sheet: its
// edge and a cross, drawn at that height over the brush.
function drawSheet(bp, app, pc, at, r, heightAt) {
    const colour = new pc.Color(0.55, 0.8, 0.95);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]
        .map(([x, z]) => stepXY(at, x * r, z * r));
    const lift = corners.map((p) => {
        const h = heightAt(p.lon, p.lat);
        return Number.isFinite(h) ? bp.toScene(p.lon, p.lat, h) : null;
    });
    for (let i = 1; i < lift.length; i++) {
        if (lift[i - 1] && lift[i]) app.drawLine(lift[i - 1], lift[i], colour);
    }
    if (lift[0] && lift[2]) app.drawLine(lift[0], lift[2], colour);
    if (lift[1] && lift[3]) app.drawLine(lift[1], lift[3], colour);
}

// A point `metres` from `at` along a compass bearing, and `x` east, `z` north.
const step = (at, deg, metres) => stepXY(at, Math.sin(deg * Math.PI / 180) * metres,
    Math.cos(deg * Math.PI / 180) * metres);
const stepXY = (at, x, z) => ({ lon: at.lon + x / (111320 * Math.cos(at.lat * Math.PI / 180)),
    lat: at.lat + z / 110540 });
