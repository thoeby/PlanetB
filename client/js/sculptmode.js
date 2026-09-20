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

// Moving over the land is a tool like the brushes, not a mode you leave
// shaping to be in: the panel had you turn Shape off, walk, and turn it back
// on, which drops what is under the pointer and re-attaches the player twice.
// Photoshop's hand, and its key.
export const PAN = { id: 'pan', words: 'Pan & zoom', key: 'h' };

// The rail, in the order it is drawn: the hand first, then the five brushes
// and the line. One of them is in hand at any moment (client/js/sculptrail.js).
export const TOOLS = [PAN, ...BRUSHES];

export const toolNamed = (id) => TOOLS.find((t) => t.id === id) ?? PAN;

// A glyph each, 24x24, in the same hand as the rest of the chrome
// (client/js/tabbar.js icon). A rail of words is a row of buttons; a rail of
// glyphs is a toolbar, and the words are on the box beside it.
export const TOOL_ICON = {
    pan: 'M12 3v18|M3 12h18|m9 6 3-3 3 3|m9 18 3 3 3-3|m6 9-3 3 3 3|m18 9 3 3-3 3',
    raise: 'M3 20h18|m12 3 5 6h-10z|M12 9v7',
    lower: 'M3 4h18|m12 21 5-6h-10z|M12 15V8',
    smooth: 'M3 16c3 0 3-8 6-8s3 8 6 8 3-8 6-8|M3 21h18',
    flatten: 'M3 14h18|M8 3v7|m5 7 3 3 3-3|M16 3v7|m13 7 3 3 3-3',
    level: 'M3 12h18|M7 3v6|m4 6 3 3 3-3|M17 21v-6|m14 18 3-3 3 3',
    line: 'm4 21 5-18|m20 21-5-18|M12 9v2|M12 14v2',
};

// What each brush does, and which of the three numbers it reads. A field a
// brush does not read is not shown: "Level to" under Smooth is a control that
// does nothing, which is worse than no control at all.
export const BRUSH_SAYS = {
    pan: { does: 'Drag to move over the land, the wheel to go in and out.'
        + ' Nothing is shaped while this is in hand.', uses: [] },
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

// What the ground under the brush is: the elevation the operator gave, and how
// far this land's own shaping has moved it. The panel could say neither, so
// "level to" was a number somebody typed in metres above the sea with nothing
// to type it from.
export function groundLine(state, ground) {
    if (!state.at) return '';
    const dem = ground?.(state.at.lon, state.at.lat);
    if (!Number.isFinite(dem)) return 'no ground under the pointer';
    const moved = state.shaping?.at(state.at.lon, state.at.lat) ?? 0;
    const here = dem + moved;
    return `${here.toFixed(1)} m here`
        + (moved ? ` \u00b7 ${moved > 0 ? '+' : ''}${moved.toFixed(2)} m of shaping`
            : ' \u00b7 as the elevation gave it')
        + (state.inside === false ? ' \u00b7 not this land' : '');
}

// What has been done to this land's ground altogether: what is saved, and what
// this tab has done since.
export function shapedLine(shaping) {
    if (!shaping) return '';
    const { cells, lowest, highest, metres } = shaping.summary();
    const was = shaping.was;
    const before = was?.rev
        ? `revision ${was.rev} \u00b7 last shaped by ${was.mine ? 'you' : was.who}`
        : 'never shaped before';
    if (!cells) return `${before} \u00b7 nothing is moved off the elevation`;
    return `${before} \u00b7 ${cells.toLocaleString()} cells moved`
        + ` (${metres.toLocaleString()} m\u00b2), from ${lowest.toFixed(1)}`
        + ` to +${highest.toFixed(1)} m`;
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
        const brush = TOOLS.find((b) => b.key === e.key.toLowerCase());
        if (brush) { e.preventDefault(); acts.brush(brush.id); return; }
        // The two keys every brush in every tool has: bigger and smaller.
        if (e.key === '[' || e.key === ']') {
            e.preventDefault();
            acts.size(Math.round(state.size * (e.key === ']' ? 1.25 : 0.8)));
        }
    };
}

// ------------------------------------------------------------- the brush

// How many segments a ring is drawn with. Enough that it reads as a circle at
// the sizes a brush is used at, and few enough to be free every frame.
const AROUND = 64;

// What a cursor in a sculpting tool looks like, and has looked like since
// Z-Brush: a ring on the surface at the brush's own radius, a second one
// inside it where the dab is at full strength, a cross at the centre and a
// short stalk standing off the ground so the middle is findable on a slope.
//
// Each ring is drawn twice, a hand's breadth apart, because `drawLine` has no
// width and one segment-wide circle disappears against grass.
const RINGS = [
    { of: 1, shade: 1 },
    { of: 0.985, shade: 1 },
    { of: 0.5, shade: 0.45 },
];

// How far the middle stands off the ground, and how long the cross is.
const STALK_M = 1.5;

// The brush, on the ground, where the pointer is. A brush you cannot see is a
// brush you find the size of by moving the ground and undoing it.
//
// Three colours: the ordinary one, red for ground that is not this land, and
// dim for a pointer that has run off the ground altogether — the last is drawn
// where the ground was last found rather than not drawn at all, so the cursor
// never simply vanishes.
export function drawBrush(ctx, state) {
    if (!state.on || !state.at || !ctx.app) return;
    // The hand shapes nothing, so a twelve-metre ring under it is a ring that
    // says something will happen where nothing will.
    if (state.brush === 'pan') return;
    const { app, pc } = ctx;
    const tone = (shade) => (state.lost ? new pc.Color(0.6 * shade, 0.6 * shade, 0.6 * shade)
        : state.inside === false ? new pc.Color(shade, 0.35 * shade, 0.3 * shade)
            : new pc.Color(0.5 * shade, 0.9 * shade, shade));
    const metres = Math.max(state.size, 1) / 2;
    for (const { of, shade } of RINGS) ring(ctx, state.at, metres * of, tone(shade), app);
    middle(ctx, state, metres, tone(1), app, pc);
    drawLine(ctx, state);
}

// One circle, laid on the ground so it lies on a hillside rather than through
// it: every point is lifted to the height under it.
function ring(ctx, at, metres, colour, app) {
    let was = null;
    for (let i = 0; i <= AROUND; i++) {
        const a = (i / AROUND) * Math.PI * 2;
        const p = offset(ctx, at, Math.cos(a) * metres, Math.sin(a) * metres);
        if (p && was) app.drawLine(was, p, colour);
        was = p;
    }
}

// The centre: a cross on the ground and a stalk standing off it. The ring
// alone says nothing about where the middle of a twelve-metre brush is on a
// slope, and on flat ground seen from above it says nothing about which way is
// up.
function middle(ctx, state, metres, colour, app, pc) {
    const mid = offset(ctx, state.at, 0, 0);
    if (!mid) return;
    const arm = Math.min(metres / 3, 4);
    for (const [dx, dz] of [[arm, 0], [-arm, 0], [0, arm], [0, -arm]]) {
        const end = offset(ctx, state.at, dx, dz);
        if (end) app.drawLine(mid, end, colour);
    }
    app.drawLine(mid, new pc.Vec3(mid.x, mid.y + STALK_M, mid.z), colour);
}

// The path the Along-line brush is being clicked out, on the ground. It was
// kept in `state.line` and drawn nowhere: you clicked points into the world
// and the only sign any of them had landed was the bed appearing at the end.
function drawLine(ctx, state) {
    const points = state.line ?? [];
    if (state.brush !== 'line' || !points.length) return;
    const { app, pc } = ctx;
    const colour = new pc.Color(1, 0.85, 0.35);
    const on = points.map((g) => offset(ctx, g, 0, 0)).filter(Boolean);
    for (let i = 1; i < on.length; i++) app.drawLine(on[i - 1], on[i], colour);
    // A cross at each corner, so one click reads as a corner before there are
    // two of them to draw a line between.
    for (const p of on) {
        for (const [dx, dy] of [[1.5, 0], [0, 1.5]]) {
            app.drawLine(new pc.Vec3(p.x - dx, p.y - dy, p.z),
                new pc.Vec3(p.x + dx, p.y + dy, p.z), colour);
        }
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
