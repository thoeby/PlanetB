// symbollist.js — the left column of Settings · Symbols: every symbol there
// is, grouped by the kind of thing it is about, in the order that decides who
// wins where two of them match the same feature.
//
// It was a flat list of buttons with "highway · Surface + Repeat" beside each,
// and the order — which is the whole of how symbols resolve — could only be
// changed by typing a number into the form. A stack somebody has to read the
// numbers of is a stack nobody reorders.
//
// Nodes and events only. client/js/symbolsui.js owns the data and does the
// saving; nothing here asks the database anything.

import { el } from './poolui.js';

// The kinds, in the order the world's own vocabulary gives them, with the ones
// that have symbols first. A heading for a kind nobody has written a symbol
// for is a heading over nothing.
const headed = (rows) => {
    const by = new Map();
    for (const s of rows) {
        if (!by.has(s.kind)) by.set(s.kind, []);
        by.get(s.kind).push(s);
    }
    return [...by.entries()];
};

// "4 layers", "1 layer", "nothing" — the count, not the list of them. What a
// symbol lays down is read in the middle column, where it can be changed.
const layerCount = (s) => {
    const n = s.layer_count ?? (s.layers ?? []).length;
    return n ? `${n} layer${n === 1 ? '' : 's'}` : 'nothing';
};

// One symbol: a handle to drag it by, its name, how many layers it has, and
// whether it is in use at all. The switch is a checkbox, so the keyboard keeps
// working; panel.css draws a `.row-switch` checkbox as a switch.
function row(s, { at, onPick, onToggle }) {
    const pick = el('button', { type: 'button', className: 'sy-symbol' },
        el('b', { className: 'sy-symbol-name', textContent: s.name }),
        el('span', { className: 'sy-symbol-sub', textContent: layerCount(s) }));
    pick.classList.toggle('picked', s.id === at);
    pick.onclick = () => onPick(s);
    const on = el('input', { type: 'checkbox', className: 'sy-on',
        checked: s.enabled !== false, title: 'in use' });
    on.onchange = () => onToggle(s, on.checked);
    const li = el('li', { className: 'sy-row', draggable: true },
        el('span', { className: 'sy-grip', textContent: '∷', title: 'drag to reorder' }),
        pick, el('label', { className: 'row-switch sy-on-box' }, on));
    li.dataset.symbol = s.id;
    li.dataset.kind = s.kind;
    if (s.enabled === false) li.dataset.off = '1';
    // A symbol the world is not built with yet says so here as well as in the
    // middle: the list is where somebody counts what is waiting.
    if (s.applied !== s.version) li.dataset.draft = '1';
    return li;
}

// Dragging one row onto another puts it there. Only within its own kind:
// the order decides who wins between symbols that match the same feature, and
// two kinds never do.
function draggable(list, onMove) {
    let held = null;
    list.addEventListener('dragstart', (e) => {
        held = e.target.closest('.sy-row');
        if (held) held.dataset.held = '1';
    });
    list.addEventListener('dragend', () => {
        if (held) delete held.dataset.held;
        held = null;
    });
    list.addEventListener('dragover', (e) => {
        const over = e.target.closest?.('.sy-row');
        if (!held || !over || over === held || over.dataset.kind !== held.dataset.kind) return;
        e.preventDefault();
        const box = over.getBoundingClientRect();
        const after = e.clientY > box.top + box.height / 2;
        over.parentNode.insertBefore(held, after ? over.nextSibling : over);
    });
    list.addEventListener('drop', (e) => {
        if (!held) return;
        e.preventDefault();
        const kind = held.dataset.kind;
        const order = [...list.querySelectorAll(`.sy-row[data-kind="${kind}"]`)]
            .map((li) => li.dataset.symbol);
        onMove(kind, order);
    });
}

export function mountSymbolList(host, { onPick, onToggle, onMove, onNew }) {
    const list = el('ul', { className: 'sy-list' });
    const news = el('button', { type: 'button', className: 'sy-new',
        textContent: 'New symbol' });
    news.onclick = onNew;
    host.append(
        el('div', { className: 'spread sy-list-head' },
            el('span', { className: 'label', textContent: 'Symbols' }), news),
        list,
        el('p', { className: 'note sy-list-foot',
            textContent: 'Drag to reorder. The order decides who wins where two'
                + ' symbols match the same feature.' }));
    draggable(list, onMove);
    return {
        draw(rows, at) {
            if (!rows.length) {
                list.replaceChildren(el('li', { className: 'muted',
                    textContent: 'no symbols yet — what is drawn becomes nothing' }));
                return;
            }
            list.replaceChildren(...headed(rows).flatMap(([kind, of]) => [
                el('li', { className: 'sy-kind label', textContent: kind }),
                ...of.map((s) => row(s, { at, onPick, onToggle })),
            ]));
        },
    };
}
