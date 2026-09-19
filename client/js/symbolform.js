// symbolform.js — the middle of the Symbols part: when a symbol applies, and
// what it lays down.
//
// FND.7. The filter builder is the rules editor's, because that part of a rule
// was right. The layer stack is new: add one of the seven, drag to reorder,
// hide it, drop it — and the selected one's form is built from
// client/lib/symbols.js, so a field the compiler reads is a field the editor
// offers and there is no second list.

import { LAYERS, layerNamed, layerWords } from '../lib/symbols.js';
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

// ----------------------------------------------------------------- layers

// One line of the stack: what it is, an eye, and a handle to drag it by.
function layerRow(layer, i, state, redraw) {
    const pick = el('button', { type: 'button', className: 'sy-layer',
        textContent: layerWords(layer.layer) });
    pick.classList.toggle('picked', state.layerAt === i);
    pick.onclick = () => { state.layerAt = i; redraw(); };
    const eye = el('input', { type: 'checkbox', className: 'sy-eye',
        checked: layer.enabled !== false, title: 'in use' });
    eye.onchange = () => { layer.enabled = eye.checked; redraw(); };
    const up = el('button', { type: 'button', className: 'sy-up', textContent: '↑' });
    up.onclick = () => { move(state, i, -1); redraw(); };
    const down = el('button', { type: 'button', className: 'sy-down', textContent: '↓' });
    down.onclick = () => { move(state, i, 1); redraw(); };
    const drop = el('button', { type: 'button', className: 'sy-drop', textContent: '×' });
    drop.onclick = () => {
        state.layers.splice(i, 1);
        state.layerAt = Math.min(state.layerAt, state.layers.length - 1);
        redraw();
    };
    return el('li', {}, pick, eye, up, down, drop);
}

function move(state, i, by) {
    const to = i + by;
    if (to < 0 || to >= state.layers.length) return;
    const [got] = state.layers.splice(i, 1);
    state.layers.splice(to, 0, got);
    state.layerAt = to;
}

// The selected layer's own form, a field at a time, as client/lib/symbols.js
// describes it. A product field is a catalogue number with what it has to be
// written beside it.
function layerForm(layer, state, redraw) {
    const known = layerNamed(layer.layer);
    if (!known) return el('div', { className: 'muted', textContent: 'no such layer' });
    const rows = known.fields.map((field) => fieldRow(field, layer, redraw));
    const when = el('div', { className: 'sy-layer-when' },
        ...(layer.when ?? []).map((c) => condRow(c, 'sy-lcond')));
    const add = el('button', { type: 'button', className: 'sy-add-lcond',
        textContent: 'Only when…' });
    add.onclick = () => { when.append(condRow({}, 'sy-lcond')); redraw(false); };
    when.addEventListener('gone', () => redraw(false));
    for (const node of when.querySelectorAll('input, select')) {
        node.addEventListener('change', () => redraw(false));
    }
    return el('div', { className: 'sy-layer-form' },
        el('div', { className: 'note', textContent: `${known.note} (${known.on})` }),
        ...rows, el('span', { className: 'label', textContent: 'Only when' }), when, add,
        el('input', { type: 'hidden', className: 'sy-at', value: String(state.layerAt) }));
}

function fieldRow(field, layer, redraw) {
    const value = layer.params?.[field.name];
    const set = (v) => {
        layer.params = layer.params ?? {};
        if (v === undefined || v === '') delete layer.params[field.name];
        else layer.params[field.name] = v;
        redraw(false);
    };
    if (field.kind === 'choice') {
        const sel = el('select', { className: `sy-f sy-f-${field.name}` });
        sel.append(...field.of.map((o) => new Option(o, o)));
        sel.value = String(value ?? field.value ?? field.of[0]);
        sel.onchange = () => set(sel.value);
        return el('label', {}, `${field.label} `, sel);
    }
    const input = el('input', { type: 'text', className: `sy-f sy-f-${field.name}`,
        placeholder: field.kind === 'product' ? 'catalogue number' : String(field.value ?? ''),
        value: value === undefined ? '' : (typeof value === 'object'
            ? JSON.stringify(value) : String(value)) });
    input.onchange = () => set(field.kind === 'number' ? parse(input.value) : input.value.trim());
    return el('label', {}, `${field.label} `, input);
}

/** The stack and the selected layer's form, redrawn together. */
export function mountLayers(host, state, onChange) {
    const redraw = (rebuild = true) => {
        if (rebuild) {
            const list = el('ul', { className: 'sy-stack rows' },
                ...state.layers.map((l, i) => layerRow(l, i, state, redraw)));
            const form = state.layers[state.layerAt]
                ? layerForm(state.layers[state.layerAt], state, redraw)
                : el('div', { className: 'muted', textContent: 'no layers yet' });
            const add = el('select', { className: 'sy-add-layer' });
            add.append(new Option('add a layer…', ''),
                ...LAYERS.map((l) => new Option(l.words, l.id)));
            add.onchange = () => {
                if (!add.value) return;
                state.layers.push({ layer: add.value, params: {} });
                state.layerAt = state.layers.length - 1;
                redraw();
            };
            host.replaceChildren(el('span', { className: 'label', textContent: 'Layers' }),
                list, add, form);
        }
        onChange?.();
    };
    redraw();
    return { redraw };
}

// What the layer forms say, as the `layers` of a symbol.
export const collectLayers = (host, state) => state.layers.map((l, i) => {
    const when = i === state.layerAt ? condsIn(host, '.sy-lcond') : (l.when ?? []);
    const out = { layer: l.layer, params: l.params ?? {} };
    if (l.enabled === false) out.enabled = false;
    if (when.length) out.when = when;
    return out;
});
