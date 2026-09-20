// symbolform.js — when a symbol applies: the conditions, every one of which
// has to hold.
//
// FND.7. The filter builder is the rules editor's, because that part of a rule
// was right. What a symbol lays down is client/js/symbollayers.js, and the
// left and right columns are symbollist.js and symboltry.js.

import { el } from './poolui.js';

export const OPS = ['eq', 'ne', 'in', 'has', 'lt', 'lte', 'gt', 'gte',
    'exists', 'missing'];
const NO_VALUE = ['exists', 'missing'];

// A row took itself out; whoever is holding the rows redraws.
const gone = () => new CustomEvent('gone', { bubbles: true });

// Typed as JSON when it parses as JSON, as a plain word when it does not:
// nobody should have to put quotes around gable.
export const parse = (text) => {
    const raw = String(text ?? '').trim();
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch { return raw; }
};

// ------------------------------------------------------------------- when

export function condRow(cond = {}, className = 'sy-cond') {
    const prop = el('input', { className: 'prop', placeholder: 'property',
        value: cond.prop ?? '' });
    const op = el('select', { className: 'op' });
    for (const name of OPS) op.append(new Option(name, name));
    op.value = cond.op ?? 'eq';
    const val = el('input', { className: 'val', placeholder: 'value, or ["a","b"]',
        value: cond.value === undefined ? '' : JSON.stringify(cond.value) });
    const drop = el('button', { type: 'button', textContent: '×' });
    const row = el('div', { className }, prop, op, val, drop);
    drop.onclick = () => {
        const host = row.parentNode;
        row.remove();
        host?.dispatchEvent(gone());
    };
    return row;
}

export const condsIn = (host, sel) => [...host.querySelectorAll(sel)].map((row) => {
    const op = row.querySelector('.op').value;
    const cond = { prop: row.querySelector('.prop').value.trim(), op };
    if (!NO_VALUE.includes(op)) cond.value = parse(row.querySelector('.val').value);
    return cond;
}).filter((cond) => cond.prop);

