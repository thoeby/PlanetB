// symboltry.js — the right column of Settings · Symbols: the values the sample
// is tried with, and every version this symbol has been saved as.
//
// The try-values were a column of "property" and "value" text boxes somebody
// had to know the names to fill in. A symbol already says which properties it
// cares about — they are the ones in its conditions, and in its layers' — so
// the row is offered, and the widget is the one the condition's own value
// implies: a switch for yes, a stepper for a number, a field for a word.
//
// The history was behind a button that had to be pressed. A version list
// nobody can see is a version list nobody uses, so it is simply there, with
// who saved each one and which of them the world is built with (db/0175).

import { el } from './poolui.js';

const YES = ['yes', 'no', 'true', 'false', '1', '0'];

// Which widget a property wants, from what the symbol compares it against.
export function widgetOf(value) {
    if (value === undefined || value === null) return 'text';
    if (typeof value === 'boolean') return 'switch';
    if (Array.isArray(value)) return 'text';
    if (typeof value === 'number') return 'number';
    const said = String(value).trim().toLowerCase();
    if (YES.includes(said)) return 'switch';
    return said !== '' && Number.isFinite(Number(said)) ? 'number' : 'text';
}

// Every property this symbol mentions, with the first value it is compared
// against — that is what decides the widget. Conditions on the symbol itself
// first, then the ones inside its layers, because the first are what the whole
// symbol is about.
export function propsOf(symbol) {
    const out = new Map();
    const take = (conds) => {
        for (const c of conds ?? []) {
            if (c?.prop && !out.has(c.prop)) out.set(c.prop, c.value);
        }
    };
    take(symbol?.filter);
    for (const layer of symbol?.layers ?? []) take(layer.when);
    return [...out.entries()];
}

const truthy = (v) => ['yes', 'true', '1', 'on'].includes(String(v).trim().toLowerCase());

// One row: the property's name, and the control its value asks for. Every one
// of them writes a string, because a feature's properties are strings.
function tryRow(name, value, at, onChange, free = false) {
    const kind = widgetOf(value);
    const now = at ?? (kind === 'switch' ? 'yes' : kind === 'number' ? '1' : '');
    // A property the symbol asks about is named for you; one you added is a
    // field, because naming it is the whole point of adding it.
    const named = free
        ? el('input', { className: 'sy-try-name', value: name, placeholder: 'property' })
        : el('span', { className: 'sy-try-name', textContent: name });
    if (free) named.onchange = () => { row.dataset.prop = named.value.trim(); onChange(); };
    const row = el('div', { className: 'sy-try' }, named);
    row.dataset.prop = name;
    if (free) row.dataset.free = '1';
    row.dataset.kind = kind;
    if (kind === 'switch') {
        const box = el('input', { type: 'checkbox', className: 'sy-try-val',
            checked: truthy(now) });
        box.onchange = () => onChange();
        row.append(el('label', { className: 'row-switch sy-try-switch' }, box,
            el('span', { className: 'sy-try-says',
                textContent: truthy(now) ? 'yes' : 'no' })));
        box.addEventListener('change', () => {
            row.querySelector('.sy-try-says').textContent = box.checked ? 'yes' : 'no';
        });
        return row;
    }
    if (kind === 'number') {
        const field = el('input', { type: 'text', className: 'sy-try-val mono', value: now });
        const step = (by) => {
            field.value = String((Number(field.value) || 0) + by);
            onChange();
        };
        field.onchange = onChange;
        row.append(el('div', { className: 'sy-step' },
            el('button', { type: 'button', textContent: '−',
                onclick: () => step(-1), title: 'one less' }),
            field,
            el('button', { type: 'button', textContent: '+',
                onclick: () => step(1), title: 'one more' })));
        return row;
    }
    const field = el('input', { type: 'text', className: 'sy-try-val', value: now,
        placeholder: 'anything' });
    field.onchange = onChange;
    row.append(field);
    return row;
}

// What the rows say, as a feature's properties would.
export const tryValues = (host) => Object.fromEntries(
    [...host.querySelectorAll('.sy-try')].map((row) => {
        const box = row.querySelector('.sy-try-val');
        return [row.dataset.prop,
            row.dataset.kind === 'switch' ? (box.checked ? 'yes' : 'no') : box.value];
    }).filter(([name]) => name));

export function mountTry(host, onChange) {
    let held = {};
    const rows = el('div', { className: 'sy-tries' });
    const add = el('button', { type: 'button', className: 'sy-add-prop',
        textContent: 'Add a property' });
    host.append(rows, add);
    const changed = () => { held = tryValues(rows); onChange(); };
    add.onclick = () => {
        rows.append(tryRow('', '', '', changed, true));
        rows.querySelector('.sy-try[data-free] .sy-try-name')?.focus();
    };
    return {
        // The properties the symbol asks about, keeping whatever was typed
        // into a row that is still there: changing a condition's value must
        // not silently throw away the value being tried.
        show(symbol) {
            const was = tryValues(rows);
            const asked = new Set(propsOf(symbol).map(([name]) => name));
            // A row somebody added by hand stays, whatever the symbol asks
            // about: they added it to see what the sample does with it.
            const mine = [...rows.querySelectorAll('.sy-try[data-free]')]
                .map((r) => r.dataset.prop).filter((n) => n && !asked.has(n));
            rows.replaceChildren(
                ...propsOf(symbol).map(([name, value]) =>
                    tryRow(name, value, was[name] ?? held[name], changed)),
                ...mine.map((name) => tryRow(name, was[name], was[name], changed, true)));
            held = tryValues(rows);
        },
        values: () => tryValues(rows),
    };
}

// ---------------------------------------------------------------- history

const when = (at) => {
    const d = new Date(at);
    const days = (Date.now() - d.getTime()) / 86400000;
    if (days < 1) return 'today';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

// What a version is, in one word on the right of its line: the one the world
// is built with, the one being edited, or one anybody may open.
const state = (v) => (v.in_world ? 'in world' : v.current ? 'draft' : 'open');

function versionRow(v, onOpen) {
    const open = el('button', { type: 'button', className: 'sy-version' },
        el('span', { className: 'sy-v-no mono', textContent: `v${v.version}` }),
        el('span', { className: 'sy-v-who',
            textContent: `${v.mine ? 'you' : v.who} · ${when(v.saved_at)}`
                + (v.in_world ? ' · applied to the world' : '') }));
    open.onclick = () => onOpen(v);
    const li = el('li', { className: 'sy-v-row' }, open,
        el('span', { className: 'sy-v-state', textContent: state(v) }));
    li.dataset.state = state(v).replace(' ', '-');
    return li;
}

export function mountHistory(host, onOpen) {
    const list = el('ul', { className: 'sy-versions' });
    host.append(el('span', { className: 'label', textContent: 'History' }), list);
    return {
        draw(rows) {
            list.replaceChildren(...(rows?.length
                ? rows.map((v) => versionRow(v, onOpen))
                : [el('li', { className: 'muted',
                    textContent: 'never saved — this symbol is still a draft' })]));
        },
    };
}
