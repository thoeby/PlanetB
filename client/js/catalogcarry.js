// catalogcarry.js — the Register form's "Carried and holding" step (LV.4).
//
// A product may be picked up and carried (`carry {kind}`), or hold things
// that are (`hold {capacity, kinds}`). Both are part of what the product is,
// and so of its catalogue number (db/0205).

import { el } from './poolui.js';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function carryForm(state, changed) {
    const carry = el('input', { type: 'checkbox', className: 'mk-carry',
        checked: Boolean(state.carry) });
    const kind = el('input', { type: 'text', className: 'mk-carry-kind',
        value: state.carry?.kind ?? 'crate', maxLength: 30 });
    const setCarry = () => changed(() => {
        state.carry = carry.checked && TOKEN.test(kind.value.trim())
            ? { kind: kind.value.trim() } : null;
    });
    carry.addEventListener('change', setCarry);
    kind.addEventListener('change', setCarry);

    const holds = el('input', { type: 'checkbox', className: 'mk-hold',
        checked: Boolean(state.hold) });
    const capacity = el('input', { type: 'number', className: 'mk-hold-capacity', min: '1',
        value: String(state.hold?.capacity ?? 4) });
    const kinds = el('input', { type: 'text', className: 'mk-hold-kinds',
        placeholder: 'any kind', value: (state.hold?.kinds ?? []).join(', ') });
    const setHold = () => changed(() => {
        const list = kinds.value.split(',').map((k) => k.trim()).filter((k) => TOKEN.test(k));
        state.hold = holds.checked
            ? { capacity: Math.max(1, Number(capacity.value) || 1), kinds: list } : null;
    });
    for (const i of [holds, capacity, kinds]) i.addEventListener('change', setHold);

    return el('div', { className: 'mk-carry-form' },
        el('span', { className: 'label', textContent: 'Carried and holding' }),
        el('label', {}, carry, ' may be picked up and carried, as a ', kind),
        el('label', {}, holds, ' holds ', capacity, ' things of kind ', kinds));
}
