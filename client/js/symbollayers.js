// symbollayers.js — what a symbol lays down: the stack, in the order it runs
// in, beside the one being edited.
//
// It was one list of buttons with the selected layer's form under it, so the
// stack and the form fought for the same column and a four-layer symbol was a
// page of scrolling. Now they are two columns: the stack on the left, each
// layer saying under its own word what it is set to (client/lib/symbols.js
// layerSays), and the layer in hand on the right with its fields in a grid.
//
// The form is still built from client/lib/symbols.js, so a field the compiler
// reads is a field the editor offers and there is no second list.

import { LAYERS, fieldTrouble, layerNamed, layerSays, layerWords }
    from '../lib/symbols.js';
import { condRow, condsIn, parse } from './symbolform.js';
import { el } from './poolui.js';

// One line of the stack: a handle, what it is, what it is set to, and an eye.
function layerRow(layer, i, state, redraw) {
    const pick = el('button', { type: 'button', className: 'sy-layer' },
        el('b', { className: 'sy-layer-name', textContent: layerWords(layer.layer) }),
        el('span', { className: 'sy-layer-says',
            textContent: layerSays(layer) || 'nothing set yet' }));
    pick.classList.toggle('picked', state.layerAt === i);
    pick.onclick = () => { state.layerAt = i; redraw(); };
    const eye = el('input', { type: 'checkbox', className: 'sy-eye',
        checked: layer.enabled !== false, title: 'in use' });
    eye.onchange = () => { layer.enabled = eye.checked; redraw(); };
    const li = el('li', { className: 'sy-layer-row', draggable: true },
        el('span', { className: 'sy-grip', textContent: '∷', title: 'drag to reorder' }),
        pick, el('label', { className: 'sy-eye-box', title: 'in use' }, eye));
    li.dataset.at = String(i);
    if (layer.enabled === false) li.dataset.off = '1';
    return li;
}

// Dragging one layer onto another puts it there. The order is what the ground
// is painted in, so it is the one thing about a stack that has to be easy.
function draggable(list, state, redraw) {
    let from = null;
    list.addEventListener('dragstart', (e) => {
        from = Number(e.target.closest('.sy-layer-row')?.dataset.at);
    });
    list.addEventListener('dragover', (e) => {
        if (Number.isFinite(from) && e.target.closest?.('.sy-layer-row')) e.preventDefault();
    });
    list.addEventListener('drop', (e) => {
        const over = e.target.closest?.('.sy-layer-row');
        if (!over || !Number.isFinite(from)) return;
        e.preventDefault();
        const to = Number(over.dataset.at);
        if (to === from) return;
        const [got] = state.layers.splice(from, 1);
        state.layers.splice(to, 0, got);
        state.layerAt = to;
        from = null;
        redraw();
    });
}

// One field of the layer in hand. A product field that names the wrong kind of
// product says so on the field itself, because "Asphalt is a surface material"
// is only useful next to the box Asphalt was typed into.
function fieldRow(field, layer, trouble, redraw) {
    const value = layer.params?.[field.name];
    const set = (v) => {
        layer.params = layer.params ?? {};
        if (v === undefined || v === '') delete layer.params[field.name];
        else layer.params[field.name] = v;
        redraw(false);
    };
    const box = el('label', { className: 'sy-field' },
        el('span', { className: 'label', textContent: field.label }));
    box.dataset.field = field.name;
    if (field.kind === 'choice') {
        const sel = el('select', { className: `sy-f sy-f-${field.name}` });
        sel.append(...field.of.map((o) => new Option(o, o)));
        sel.value = String(value ?? field.value ?? field.of[0]);
        sel.onchange = () => set(sel.value);
        box.append(sel);
        return box;
    }
    const input = el('input', { type: 'text', className: `sy-f sy-f-${field.name}`,
        placeholder: field.kind === 'product' ? 'catalogue number' : String(field.value ?? ''),
        value: value === undefined ? '' : (typeof value === 'object'
            ? JSON.stringify(value) : String(value)) });
    input.onchange = () => set(field.kind === 'number' ? parse(input.value) : input.value.trim());
    box.append(input);
    if (trouble?.field === field.name) {
        box.dataset.bad = '1';
        box.append(el('span', { className: 'sy-field-bad', textContent: trouble.said }));
    }
    return box;
}

// The "only when" of one layer: the same conditions the symbol itself has, for
// the times a stack does one thing on a lit road and another on a dark one.
function onlyWhen(layer, redraw) {
    const when = el('div', { className: 'sy-layer-when' },
        ...(layer.when ?? []).map((c) => condRow(c, 'sy-lcond')));
    const add = el('button', { type: 'button', className: 'sy-add-lcond',
        textContent: 'Add condition' });
    add.onclick = () => { when.append(condRow({}, 'sy-lcond')); redraw(false); };
    when.addEventListener('gone', () => redraw(false));
    for (const node of when.querySelectorAll('input, select')) {
        node.addEventListener('change', () => redraw(false));
    }
    return el('div', { className: 'sy-only' },
        el('span', { className: 'label', textContent: 'Only when' }), when, add,
        el('p', { className: 'note',
            textContent: 'Numbers may also come from a property:'
                + ' {"prop": "lanes", "times": 3, "min": 6, "else": 6}.' }));
}

// The layer in hand, whole: its name, where it is in the stack, its fields in
// a grid, and what it does only when.
function layerForm(state, typeOf, redraw) {
    const layer = state.layers[state.layerAt];
    if (!layer) {
        return el('div', { className: 'sy-layer-form empty muted',
            textContent: 'no layer in hand — add one, or pick one from the stack' });
    }
    const known = layerNamed(layer.layer);
    if (!known) {
        return el('div', { className: 'sy-layer-form muted',
            textContent: `there is no layer called ${layer.layer}` });
    }
    const trouble = fieldTrouble(layer, typeOf);
    return el('div', { className: 'sy-layer-form' },
        el('div', { className: 'spread sy-form-head' },
            el('span', { className: 'label' },
                `${known.words} · `,
                el('i', { textContent: layerSays(layer) || 'nothing set yet' })),
            el('span', { className: 'muted',
                textContent: `layer ${state.layerAt + 1} of ${state.layers.length}` })),
        el('p', { className: 'note', textContent: `${known.note} (${known.on})` }),
        el('div', { className: 'sy-fields' },
            ...known.fields.map((f) => fieldRow(f, layer, trouble, redraw))),
        onlyWhen(layer, redraw),
        el('input', { type: 'hidden', className: 'sy-at', value: String(state.layerAt) }));
}

function stack(state, redraw) {
    const add = el('select', { className: 'sy-add-layer' });
    add.append(new Option('Add layer', ''), ...LAYERS.map((l) => new Option(l.words, l.id)));
    add.onchange = () => {
        if (!add.value) return;
        state.layers.push({ layer: add.value, params: {} });
        state.layerAt = state.layers.length - 1;
        redraw();
    };
    const drop = el('button', { type: 'button', className: 'sy-drop-layer',
        textContent: 'Remove this layer' });
    drop.onclick = () => {
        if (!state.layers.length) return;
        state.layers.splice(state.layerAt, 1);
        state.layerAt = Math.max(0, Math.min(state.layerAt, state.layers.length - 1));
        redraw();
    };
    const list = el('ul', { className: 'sy-stack' },
        ...state.layers.map((l, i) => layerRow(l, i, state, redraw)));
    if (!state.layers.length) {
        list.append(el('li', { className: 'muted',
            textContent: 'no layers yet — this symbol draws nothing' }));
    }
    draggable(list, state, redraw);
    return el('div', { className: 'sy-stack-col' },
        el('div', { className: 'spread' },
            el('span', { className: 'label', textContent: 'Layers · in order' }), add),
        list,
        el('p', { className: 'note',
            textContent: 'The ground is painted first, then these run in this order.' }),
        drop);
}

/** The stack and the layer in hand, redrawn together. */
export function mountLayers(host, state, onChange, typeOf = () => null) {
    const redraw = (rebuild = true) => {
        if (rebuild) {
            host.replaceChildren(stack(state, redraw),
                layerForm(state, typeOf, redraw));
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
