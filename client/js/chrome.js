// chrome.js — the instruments around the edge of the world: the compass and
// the place line at the top, the key hints in the corner, and the five-stage
// pipeline. Nodes and arithmetic only; client/js/hud.js puts them on the
// screen and decides nothing here either.
//
// Split out of hud.js when that file outgrew the four hundred lines CLAUDE.md
// allows. The altimeter up the right-hand edge is client/js/altimeter.js and
// the map in the corner is client/js/hudmap.js; these are the rest of it.

import { STAGES } from './stages.js';

export const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

// A strip of headings that slides under a fixed needle: the point under the
// needle is the way the camera is facing.
//
// Ruled like the altimeter's ladder, and for the same reason: a row of eight
// letters is a label, and what an instrument has to show is how far it is to
// the next one. A tick every 15°, tall and lit where a point is named, short
// between — so a quarter turn is eight ticks whether or not a letter is under
// the needle.
function compass() {
    const node = el('div', { id: 'compass', className: 'glass' });
    const marks = [];
    for (let i = 0; i < 24; i++) {
        const deg = i * 15;
        const name = deg % 45 === 0 ? POINTS[(deg / 45) % 8] : '';
        const span = el('span', {}, el('i', { className: 'tick' }),
            el('b', { textContent: name }));
        if (name) span.dataset.cardinal = '1';
        span.dataset.deg = String(deg);
        marks.push(span);
        node.append(span);
    }
    node.append(el('span', { className: 'needle' }));
    // Which heading sits where, relative to the needle: ±90° across the strip.
    const face = (heading) => {
        for (const m of marks) {
            let d = Number(m.dataset.deg) - heading;
            d = ((d + 540) % 360) - 180;
            // A mark at the very edge is cut in half by the strip's own clip,
            // which reads as a typo rather than as a compass.
            m.style.display = Math.abs(d) > 80 ? 'none' : '';
            m.style.left = `${50 + (d / 92) * 50}%`;
        }
    };
    face(0);
    return { node, face };
}

export function topCentre() {
    const c = compass();
    const land = el('div', { id: 'land', textContent: 'nowhere yet' });
    const owner = el('span', { className: 'owner' });
    const right = el('span', { className: 'right', textContent: 'read only' });
    const coords = el('span', { className: 'coords', textContent: '—' });
    const standing = el('div', { id: 'standing' },
        owner, el('span', { className: 'dot' }), right,
        el('span', { className: 'dot' }), coords);
    return { node: el('div', { id: 'where' }, c.node, land, standing),
        face: c.face, land, owner, right, coords };
}

// Which way you are moving, and the keys that go with it. Walking and flying
// are different controls — Shift runs on the ground and goes down in the air,
// and forward follows where you are looking only in the air — so the corner
// says which of the two you are in rather than listing both and leaving it to
// be discovered. A key hint is not decoration: it is the only way to learn
// that the keys work at all.
const MOVE = {
    walk: { name: 'Walking', keys: [['Move', 'W A S D'], ['Look', 'drag'],
        ['Run', 'Shift'], ['Fly', 'F']] },
    fly: { name: 'Flying', keys: [['Fly where you look', 'W A S D'],
        ['Look', 'drag'], ['Up', 'Space'], ['Down', 'Shift'], ['Walk', 'F']] },
};

export function keyHints() {
    const node = el('div', { id: 'hints', className: 'glass' });
    drawHints(node, 'walk');
    return node;
}

export function drawHints(node, mode) {
    const how = MOVE[mode] ?? MOVE.walk;
    node.dataset.mode = mode;
    node.replaceChildren(
        el('span', { className: 'mode' },
            el('i', { className: 'pip' }),
            el('b', { className: 'mode-name', textContent: how.name })),
        ...how.keys.map(([what, key]) =>
            el('span', {}, el('b', { textContent: what }), ` ${key}`)),
        el('span', {}, el('b', { textContent: 'Close panel' }), ' Esc'));
}

// The route through the app, always visible: how many things you have placed,
// how many tiles are in the pool, how many of those a renderer holds, how many
// are waiting for a person, how many are published. Credits are not a stage —
// they are on the bar, in the chip that is you.
export function pipeline() {
    const strip = el('div', { id: 'pipeline', className: 'glass' });
    const cells = {};
    for (const st of STAGES) {
        const value = el('span', { className: 'value', textContent: '0' });
        const cell = el('div', { className: 'stage' },
            el('span', { className: 'label', textContent: st.label }), value,
            el('i', {}));
        if (st.tone) cell.dataset.tone = st.tone;
        cell.dataset.stat = st.key;
        cells[st.key] = value;
        strip.append(cell);
    }
    return { node: el('div', { id: 'stats' }, strip), cells };
}

// Where the player is standing and which way they are facing: the top of the
// screen, written from plain strings. The chrome decides nothing.
export function place(top) {
    return {
        standing({ land, owner, right, may }) {
            if (land !== undefined) top.land.textContent = land;
            if (owner !== undefined) {
                top.owner.replaceChildren('Owner ', el('b', { textContent: owner }));
                top.owner.style.visibility = owner ? '' : 'hidden';
            }
            if (right !== undefined) top.right.textContent = right;
            if (may !== undefined) top.right.dataset.may = may ? '1' : '';
        },
        at(lon, lat, h, heading) {
            const ns = lat >= 0 ? 'N' : 'S';
            const ew = lon >= 0 ? 'E' : 'W';
            top.coords.textContent =
                `${Math.abs(lat).toFixed(4)}${ns} ${Math.abs(lon).toFixed(4)}${ew}`
                + ` \u00b7 ${Math.round(h)} m`;
            if (Number.isFinite(heading)) top.face(((heading % 360) + 360) % 360);
        },
    };
}
