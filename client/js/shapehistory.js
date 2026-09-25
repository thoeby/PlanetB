// shapehistory.js — Shape's strokes since the last save, newest first
// (EDT.9, PLAN-editors.md idea 14): click one to undo back to it; the undone
// ones stay, struck through, until a new stroke replaces them. Ctrl-Z and
// Ctrl-Shift-Z walk the same list. And Put back the land, which asks first.

import { brushWords } from './sculpt.js';
import { el } from './tabbar.js';

const signed = (v) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(2)} m`;

// How long ago, in the history's words.
export function ago(at, now = Date.now()) {
    const min = Math.floor((now - at) / 60000);
    if (min < 1) return 'now';
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} h`;
}

// One stroke's line: what it was, and how far it moved the ground.
export function strokeWords(note) {
    const what = note.words ?? `${brushWords(note.brush)}${note.invert ? ' (Shift)' : ''}`;
    const bits = [what];
    if (note.size) bits.push(`${note.size} m`);
    if (note.strength && note.brush !== 'line') bits.push(`${note.strength} m/s`);
    return bits.join(' · ');
}

export function mountHistory(host, { shaping, changed }) {
    const list = el('ol', { className: 'sh-history' });
    const ask = el('div', { className: 'sh-confirm', hidden: true },
        el('span', { textContent: 'Put the whole land back as the elevation gives it?' }),
        el('button', { type: 'button', className: 'sc-clear-yes primary',
            textContent: 'Put back' }),
        el('button', { type: 'button', className: 'sc-clear-no', textContent: 'Keep it' }));
    host.append(el('div', { className: 'section sh-strokes' },
        el('div', { className: 'spread' },
            el('span', { className: 'label', textContent: 'Strokes' }),
            el('span', { className: 'muted', textContent: 'click one to undo back to it' })),
        list, ask));
    const draw = () => {
        const s = shaping();
        const rows = s ? s.history() : [];
        list.replaceChildren(...rows.map((h) => {
            const li = el('li', { className: `sh-stroke${h.done ? '' : ' undone'}` },
                el('span', { textContent: strokeWords(h) }),
                el('span', { className: 'mono', textContent: Number.isFinite(h.delta)
                    ? signed(h.delta) : '' }),
                el('span', { className: 'mono muted', textContent: ago(h.at) }));
            li.dataset.n = String(h.n);
            li.onclick = () => {
                if (h.done) s.undoTo(h.n); else s.redoTo(h.n);
                changed(h.done ? 'undone back to it' : 'redone up to it');
            };
            return li;
        }));
        if (!rows.length) list.append(el('li', { className: 'muted', textContent: 'none yet' }));
    };
    // Put back the land asks first: it is every stroke ever saved on it.
    const confirm = (yes) => {
        ask.hidden = false;
        ask.querySelector('.sc-clear-yes').onclick = () => { ask.hidden = true; yes(); };
        ask.querySelector('.sc-clear-no').onclick = () => { ask.hidden = true; };
    };
    return { draw, confirm };
}
