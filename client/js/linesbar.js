// linesbar.js — Lines' toolbar over the land, top left, and its cards (the
// operator's note on EDT.13, as for Shape: client/js/sculptrail.js). The panel
// down the left took a third of the screen for a palette, a list and a form.
//
// The bar: the land, the tools at one fixed size with their keys, undo, redo,
// what is unsaved, Save, and the Kind and Lines toggles. Under it, cards: the
// kind palette, which flaps out when Draw is picked and folds when it is
// picked again; the selected line, while one is; and the land's lines. The
// look is Shape's (client/terrain.css).

import { LINE_TOOLS } from './linetools.js';
import { el, icon } from './tabbar.js';

const deed = (cls, words, path, fn) => {
    const b = el('button', { type: 'button', className: `sc-deed ${cls}`, title: words },
        icon(path));
    b.setAttribute('aria-label', words);
    b.onclick = fn;
    return b;
};

function toolButton(t, pick) {
    const b = el('button', { type: 'button', className: `sc-brush ln-tool-${t.id}`,
        title: `${t.words} · ${t.key.toUpperCase()}` }, icon(t.icon),
    el('i', { className: 'sc-key', textContent: t.key.toUpperCase() }));
    b.dataset.tool = t.id;
    b.setAttribute('aria-label', t.words);
    b.onclick = () => pick(t.id);
    return b;
}

// A card under the bar: a head with its name and a fold, and its body.
function card(cls, name, body, onFold) {
    const fold = el('button', { type: 'button', className: 'sc-fold', title: 'Fold it away',
        textContent: '×' });
    fold.onclick = onFold;
    return el('div', { className: `ln-card ${cls} glass`, hidden: true },
        el('div', { className: 'spread' }, el('span', { className: 'label', textContent: name }),
            fold), body);
}

/**
 * The toolbar, hung on `host` (#hud). `pick(id)` picks a tool; `acts` has
 * undo, redo and save.
 */
export function linesBar(host, pick, acts) {
    const rail = el('div', { className: 'sc-rail ln-rail' },
        ...LINE_TOOLS.map((t) => toolButton(t, pick)));
    const save = deed('ln-save', 'Save the lines', 'M5 4h11l3 3v13H5z|M8 4v6h7V4|M8 20v-6h8v6',
        acts.save);
    save.append(el('span', { className: 'sc-save-words', textContent: 'Save' }));
    const kindsOn = deed('ln-kinds-toggle', 'The kinds to draw',
        'M4 4h7v7H4z|M13 4h7v7h-7z|M4 13h7v7H4z|M13 13h7v7h-7z', () => flip(kinds));
    const listOn = deed('ln-list-toggle', 'The lines on this land',
        'M4 6h16|M4 12h16|M4 18h10', () => flip(list));
    const bar = el('div', { className: 'sc-bar glass' },
        el('select', { className: 'ln-land', title: 'The land being drawn on' }),
        el('i', { className: 'sc-sep' }), rail, el('i', { className: 'sc-sep' }),
        deed('ln-undo', 'Undo · Ctrl-Z', 'M3 10h11a5 5 0 0 1 0 10h-4|m3 10 5-5|m3 10 5 5',
            acts.undo),
        deed('ln-redo', 'Redo · Ctrl-Shift-Z',
            'M21 10H10a5 5 0 0 0 0 10h4|m21 10-5-5|m21 10-5 5', acts.redo),
        el('i', { className: 'sc-sep' }), el('span', { className: 'ln-said' }),
        save, kindsOn, listOn);
    const kinds = card('ln-kind-card', 'Kind', el('div', { className: 'ln-kinds' }),
        () => flip(kinds, false));
    const selected = el('div', { className: 'ln-card ln-selected-card glass', hidden: true },
        el('div', { className: 'ln-selected-host' }));
    const list = card('ln-list-card', 'Lines on this land',
        el('div', { className: 'ln-list-host' }), () => flip(list, false));
    const node = el('div', { id: 'lines-tools', hidden: true }, bar,
        el('p', { className: 'ln-status status' }),
        el('div', { className: 'sh-cards' }, kinds, selected, list));
    host.append(node);
    const flip = (c, on = c.hidden) => {
        c.hidden = !on;
        kindsOn.setAttribute('aria-pressed', String(!kinds.hidden));
        listOn.setAttribute('aria-pressed', String(!list.hidden));
    };
    return {
        node, kinds, selected, list, flip,
        q: (sel) => node.querySelector(sel),
        // Which tool is in hand, lit; Draw flaps the palette out, and picked
        // again — or any other tool picked — folds it.
        pick(id, { toggle = false } = {}) {
            const again = node.dataset.tool === id;
            node.dataset.tool = id;
            for (const b of rail.children) {
                b.classList.toggle('picked', b.dataset.tool === id);
                b.setAttribute('aria-selected', String(b.dataset.tool === id));
            }
            flip(kinds, id === 'draw' && !(toggle && again && !kinds.hidden));
        },
    };
}
