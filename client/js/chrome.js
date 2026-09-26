// chrome.js — the instruments around the edge of the world: the compass and
// the place line under the top strip, and the controls panel in the corner.
// Nodes and arithmetic only; client/js/hud.js puts them on the screen and
// decides nothing here either.
//
// The five-stage pipeline that used to live here is gone with v6: the two
// numbers that are acted on are in the top strip (client/js/topbar.js).
//
// Split out of hud.js when that file outgrew the four hundred lines CLAUDE.md
// allows. The altimeter up the right-hand edge is client/js/altimeter.js and
// the map in the corner is client/js/hudmap.js; these are the rest of it.

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
    const node = el('div', { id: 'compass' });
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
    // UI.1: one line under the compass, in the middle of the top bar.
    return { node: el('div', { id: 'where' }, c.node,
        el('div', { className: 'line' }, land, el('span', { className: 'dot' }), standing)),
    face: c.face, land, owner, right, coords };
}

// Which way you are moving, and the keys that go with it. Walking and flying
// are different controls — Shift runs on the ground and goes down in the air,
// and forward follows where you are looking only in the air — so the corner
// says which of the two you are in rather than listing both and leaving it to
// be discovered. A key hint is not decoration: it is the only way to learn
// that the keys work at all.
const MOVE = {
    walk: { name: 'Walking', other: 'Fly', keys: [[['W', 'A', 'S', 'D'], 'Move'],
        [['drag'], 'Look'], [['Shift'], 'Run'], [['Esc'], 'Close panel']] },
    fly: { name: 'Flying', other: 'Walk', keys: [[['W', 'A', 'S', 'D'],
        'Fly where you look'], [['drag'], 'Look'], [['Space'], 'Up'],
    [['Shift'], 'Down'], [['Esc'], 'Close panel']] },
};

// UI.2: folded to one line unless somebody opened it — the mode, the four
// keys that move you and the key for the other mode; the rest on a press.
// Remembered per browser; a private window just starts folded.
const OPEN_KEY = 'splatworld.hints';
const remembered = () => {
    try { return globalThis.localStorage?.getItem(OPEN_KEY) === '1'; } catch { return false; }
};
const remember = (open) => {
    try { globalThis.localStorage?.setItem(OPEN_KEY, open ? '1' : ''); } catch { /* */ }
};

export function keyHints() {
    const node = el('div', { id: 'hints', className: 'glass' });
    node.dataset.open = remembered() ? '1' : '';
    drawHints(node, 'walk');
    return node;
}

// v6 puts the controls in a panel of their own above the map: which of the two
// you are in at the head of it, with the key for the other one, and the keys
// themselves as caps under it. A key hint is not decoration — it is the only
// way to learn that the keys work at all.
export function drawHints(node, mode) {
    const how = MOVE[mode] ?? MOVE.walk;
    node.dataset.mode = mode;
    // A space between the keys: read aloud, or by a script reading the page
    // the way a player does, "W A S D" is four keys and "WASD" is a word.
    const caps = (keys) => el('span', { className: 'caps-row' },
        ...keys.flatMap((k, i) => (i ? [' ', el('kbd', { textContent: k })]
            : [el('kbd', { textContent: k })])));
    const fold = el('button', { type: 'button', className: 'fold',
        textContent: node.dataset.open ? '\u25be' : '\u25b8' });
    fold.setAttribute('aria-label', node.dataset.open ? 'fewer keys' : 'all keys');
    fold.onclick = () => {
        node.dataset.open = node.dataset.open ? '' : '1';
        remember(Boolean(node.dataset.open));
        drawHints(node, mode);
    };
    node.replaceChildren(
        el('div', { className: 'mode' },
            el('span', { className: 'now' }, el('i', { className: 'pip' }),
                el('b', { className: 'mode-name', textContent: how.name })),
            el('span', { className: 'short' }, caps(how.keys[0][0])),
            el('span', { className: 'other' }, how.other, ' ',
                el('kbd', { textContent: 'F' })), fold),
        el('div', { className: 'keys' },
            ...how.keys.flatMap(([keys, does]) =>
                [caps(keys), el('span', { textContent: does })])));
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
