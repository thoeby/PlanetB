// catalogtriggers.js — the Register form's "Set off by" step (LV.2).
//
// A product says what sets it off: walking up to it, clicking it, a key, Use.
// Each is `{kind, params}` (db/0203); what happens then is a flow's. The form
// offers the kinds the page knows (client/js/triggers.js) with the one or two
// numbers each takes.

import { el } from './poolui.js';
import { triggerWords } from '../lib/marks.js';
import { KINDS } from './triggers.js';

const WORDS = { click: 'Clicked', near: 'Somebody comes near', far: 'Somebody walks away',
    key: 'A key is pressed near it', use: 'Somebody uses it' };

function paramsOf(kind, fields) {
    if (kind === 'near' || kind === 'far') return { m: Number(fields.m.value) || 5 };
    if (kind === 'key') return { key: fields.key.value.trim().toLowerCase() || 'e', when: 'down' };
    if (kind === 'use' && fields.part.value) return { part: fields.part.value };
    return {};
}

export function triggerForm(state, changed) {
    const kind = el('select', { className: 'mk-trigger-kind' });
    kind.append(...KINDS.map((k) => new Option(WORDS[k] ?? k, k)));
    const fields = {
        m: el('input', { type: 'number', className: 'mk-trigger-m', value: '5', min: '1' }),
        key: el('input', { type: 'text', className: 'mk-trigger-key', maxLength: 1, value: 'g' }),
        part: el('select', { className: 'mk-trigger-part' }),
    };
    fields.part.append(new Option('the whole thing', ''),
        ...state.parts.map((p) => new Option(p.name, p.name)));
    const show = () => {
        fields.m.parentElement.hidden = !['near', 'far'].includes(kind.value);
        fields.key.parentElement.hidden = kind.value !== 'key';
        fields.part.parentElement.hidden = kind.value !== 'use';
    };
    kind.addEventListener('change', show);
    const add = el('button', { type: 'button', className: 'mk-trigger-add', textContent: 'Add' });
    add.onclick = () => changed(() => {
        state.triggers.push({ kind: kind.value, params: paramsOf(kind.value, fields) });
    });
    const list = el('ul', { className: 'mk-triggers rows' }, ...state.triggers.map((t, i) => {
        const drop = el('button', { type: 'button', className: 'mk-trigger-drop',
            textContent: '×', title: 'remove' });
        drop.onclick = () => changed(() => state.triggers.splice(i, 1));
        return el('li', {}, triggerWords(t), ' ', drop);
    }));
    const form = el('div', { className: 'mk-trigger-form' },
        el('span', { className: 'label', textContent: 'Set off by' }), kind,
        el('label', {}, ' within ', fields.m, ' m'),
        el('label', {}, ' key ', fields.key),
        el('label', {}, ' part ', fields.part), add, list);
    show();
    return form;
}
