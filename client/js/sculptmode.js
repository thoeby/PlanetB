// sculptmode.js — the tools Shape has, what each is for and which numbers it
// reads, and the keys the rail prints (PLAN-editors.md §2.2).
//
// Words and arithmetic only. client/js/shapeui.js owns the panel,
// client/js/shapetool.js the pointer on the clay, client/js/sculptbrush.js
// what a dab does.

import { BRUSHES } from './sculpt.js';

// The hand moves the clay camera (client/js/bpcamera.js), and the section
// draws a profile (client/js/bpmode.js): both are Blueprint's own and are on
// every surface that opens it, with the same keys.
export const PAN = { id: 'pan', words: 'Hand', key: 'h' };
export const SECTION = { id: 'section', words: 'Section', key: 'c' };

// The rail, in the order it is drawn.
export const TOOLS = [PAN, ...BRUSHES, SECTION];

export const toolNamed = (id) => TOOLS.find((t) => t.id === id) ?? PAN;

// A glyph each, 24x24, in the same hand as the rest of the chrome
// (client/js/tabbar.js icon).
export const TOOL_ICON = {
    pan: 'M12 3v18|M3 12h18|m9 6 3-3 3 3|m9 18 3 3 3-3|m6 9-3 3 3 3|m18 9 3 3-3 3',
    raise: 'M3 20h18|m12 3 5 6h-10z|M12 9v7',
    lower: 'M3 4h18|m12 21 5-6h-10z|M12 15V8',
    smooth: 'M3 16c3 0 3-8 6-8s3 8 6 8 3-8 6-8|M3 21h18',
    flatten: 'M3 14h18|M8 3v7|m5 7 3 3 3-3|M16 3v7|m13 7 3 3 3-3',
    level: 'M3 12h18|M7 3v6|m4 6 3 3 3-3|M17 21v-6|m14 18 3-3 3 3',
    line: 'm4 21 5-18|m20 21-5-18|M12 9v2|M12 14v2',
    putback: 'M4 12a8 8 0 1 0 3-6.2|M4 4v4h4',
    section: 'M3 20 9 9l4 6 3-4 5 9|M3 4h18',
};

// What each tool does, and which of the numbers it reads. A field a tool does
// not read is not shown: "Level to" under Smooth is a control that does
// nothing, which is worse than no control at all.
export const BRUSH_SAYS = {
    pan: { does: 'Drag to move over the land, the wheel to go in and out.'
        + ' Nothing is shaped while this is in hand.', uses: [] },
    raise: { does: 'Pulls the ground up under the brush. Hold longer to go higher;'
        + ' Shift lowers instead.', uses: ['size', 'strength', 'falloff', 'shape'] },
    smooth: { does: 'Pulls every cell towards the mean of the eight around it.',
        uses: ['size', 'strength', 'falloff'] },
    flatten: { does: 'Levels the ground to a plane through where the stroke began,'
        + ' falling a little one way if you ask, so a terrace drains.',
    uses: ['size', 'strength', 'falloff', 'fall'] },
    level: { does: 'Levels it to a height you name, pick off the ground, or take from'
        + ' the floor of something standing here.',
    uses: ['size', 'strength', 'falloff', 'target'] },
    line: { does: 'Lays a road bed along a line: a flat width, a shoulder either'
        + ' side, and never steeper than the gradient you allow.',
    uses: [] },
    putback: { does: 'Rubs out your shaping under the brush, back to the ground the'
        + ' elevation gives.', uses: ['size', 'strength', 'falloff'] },
    section: { does: 'Drag a line on the ground: its height and slope open in a strip'
        + ' along the bottom.', uses: [] },
};

export const brushUses = (id, field) =>
    (BRUSH_SAYS[id]?.uses ?? []).includes(field);

// The line under the tool's name: what it is for, and how big it is. It is
// said before the first drag rather than counted after it.
export function brushLine(state) {
    const says = BRUSH_SAYS[state.brush];
    const bits = [];
    if (brushUses(state.brush, 'size')) bits.push(`${state.size} m across`);
    if (brushUses(state.brush, 'strength')) bits.push(`${state.strength} m/s`);
    return [says?.does, bits.join(' · ')].filter(Boolean).join(' ');
}

// What has been done to this land's ground altogether: what is saved, and what
// this tab has done since.
export function shapedLine(shaping) {
    if (!shaping) return '';
    const { cells, lowest, highest, metres } = shaping.summary();
    const was = shaping.was;
    const before = was?.rev
        ? `revision ${was.rev} · last shaped by ${was.mine ? 'you' : was.who}`
        : 'never shaped before';
    if (!cells) return `${before} · nothing is moved off the elevation`;
    return `${before} · ${cells.toLocaleString()} cells moved`
        + ` (${metres.toLocaleString()} m²), from ${lowest.toFixed(1)}`
        + ` to +${highest.toFixed(1)} m`;
}

// The earth moved, as the land card says it (EDT.11): "1 240 m³ raised ·
// 880 m³ lowered", or nothing where nothing is.
export function earthLine(shaping) {
    if (!shaping?.earth) return '';
    const { raised, lowered } = shaping.earth();
    const m3 = (v) => `${Math.round(v).toLocaleString('en-GB').replace(/,/g, '\u2009')} m\u00b3`;
    if (raised < 0.5 && lowered < 0.5) return 'no earth moved';
    return `${m3(raised)} raised \u00b7 ${m3(lowered)} lowered`;
}

// ------------------------------------------------------------------- keys

// Every one of these is on the rail as well (T5: no key you have to know).
// They are live only while Shape is open, because R is a letter somebody types
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
