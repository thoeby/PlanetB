// sculptmode.js — what shaping the ground is like while you are doing it: the
// brush drawn where the pointer is, the keys the panel already printed, and
// what each brush is for.
//
// FND.9. The panel said "Raise (R)" and the key did nothing; it offered Size,
// Strength and "Level to" whichever brush was in hand, two of which most
// brushes ignore; and a brush twelve metres across was invisible until a drag
// had already moved the ground. Those are the three.
//
// Arithmetic and nodes. client/js/sculptui.js owns the panel and the pointer,
// client/js/sculptbrush.js what a dab does.

import { BRUSHES } from './sculpt.js';

// What each brush does, and which of the three numbers it reads. A field a
// brush does not read is not shown: "Level to" under Smooth is a control that
// does nothing, which is worse than no control at all.
export const BRUSH_SAYS = {
    raise: { does: 'Pulls the ground up under the brush, softer towards its edge.',
        uses: ['size', 'strength'] },
    lower: { does: 'Pushes it down the same way.', uses: ['size', 'strength'] },
    smooth: { does: 'Pulls every cell towards the mean of the eight around it.',
        uses: ['size'] },
    flatten: { does: 'Levels the ground to whatever height the brush landed on.',
        uses: ['size'] },
    level: { does: 'Levels it to a height you name, wherever the brush goes.',
        uses: ['size', 'target'] },
    line: { does: 'Lays a road bed along a line: a flat width, a shoulder either'
        + ' side, and never steeper than the gradient you allow.',
    uses: [] },
};

export const brushUses = (id, field) =>
    (BRUSH_SAYS[id]?.uses ?? []).includes(field);

// The line under the brushes: what is in hand, how big it is, and what that
// will do. It is said before the first drag rather than counted after it.
export function brushLine(state) {
    const says = BRUSH_SAYS[state.brush];
    const bits = [];
    if (brushUses(state.brush, 'size')) bits.push(`${state.size} m across`);
    if (brushUses(state.brush, 'strength')) bits.push(`${state.strength} m a dab`);
    return [says?.does, bits.join(' · ')].filter(Boolean).join(' ');
}

// ------------------------------------------------------------------- keys

// Every one of these is on the panel as well (T5: no key you have to know).
// They are live only while shaping is on, because R is a letter somebody types
// into the name of a land.
export function keyHandler(state, acts) {
    return (e) => {
        if (!state.on) return;
        if (e.target?.closest?.('input, select, textarea, [contenteditable]')) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            (e.shiftKey ? acts.redo : acts.undo)();
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const brush = BRUSHES.find((b) => b.key === e.key.toLowerCase());
        if (brush) { e.preventDefault(); acts.brush(brush.id); return; }
        // The two keys every brush in every tool has: bigger and smaller.
        if (e.key === '[' || e.key === ']') {
            e.preventDefault();
            acts.size(Math.round(state.size * (e.key === ']' ? 1.25 : 0.8)));
        }
    };
}

// ------------------------------------------------------------- the brush

// How many segments the ring is drawn with. Enough that it reads as a circle
// at the sizes a brush is used at, and few enough to be free every frame.
const AROUND = 48;

// The brush, on the ground, where the pointer is: a ring at its own radius,
// following the ground under it so it lies on a hillside rather than through
// it, and a cross at the middle. A brush you cannot see is a brush you find
// the size of by moving the ground and undoing it.
export function drawBrush(ctx, state) {
    if (!state.on || !state.at || !ctx.app) return;
    const { app, pc } = ctx;
    const colour = state.inside === false ? new pc.Color(1, 0.35, 0.3)
        : new pc.Color(0.5, 0.9, 1);
    const metres = Math.max(state.size, 1) / 2;
    const ring = [];
    for (let i = 0; i <= AROUND; i++) {
        const a = (i / AROUND) * Math.PI * 2;
        const p = offset(ctx, state.at, Math.cos(a) * metres, Math.sin(a) * metres);
        if (p) ring.push(p);
    }
    for (let i = 1; i < ring.length; i++) app.drawLine(ring[i - 1], ring[i], colour);
    // And a cross where it is pointed, because the ring alone says nothing
    // about where the middle of a twelve-metre brush is on a slope.
    const mid = offset(ctx, state.at, 0, 0);
    if (!mid) return;
    for (const [dx, dz] of [[metres / 4, 0], [-metres / 4, 0], [0, metres / 4],
        [0, -metres / 4]]) {
        const end = offset(ctx, state.at, dx, dz);
        if (end) app.drawLine(mid, end, colour);
    }
}

// A point `dx`, `dz` metres from where the pointer is, lifted to the ground
// under it and a hand's breadth above, so the line is not buried in the hill.
const LIFT_M = 0.25;

function offset(ctx, at, dx, dz) {
    const lat = at.lat + (dz / 111320);
    const lon = at.lon + (dx / (111320 * Math.cos((at.lat * Math.PI) / 180) || 1));
    const h = (ctx.groundAt?.(lon, lat) ?? 0) + (ctx.shapedAt?.(lon, lat) ?? 0) + LIFT_M;
    const p = ctx.origin?.localOf({ lon, lat, h });
    return p ? new ctx.pc.Vec3(p.x, p.y, p.z) : null;
}
