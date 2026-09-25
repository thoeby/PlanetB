// areaspanel.js — the columns round the Areas map (EDT.20-22,
// docs/design/splatworld-v11.dc.html 11d): the tools over it, the kinds and
// the brush down the left, and down the right the selected area's fields and
// Save.

import { AREA_TOOLS } from './areastools.js';
import { mountKindPicker } from './kindpicker.js';
import { el } from './tabbar.js';

const ICON = { pan: '✋', draw: '✎', paint: '●', edit: '⌖', erase: '⌫' };

export function mountColumns(q, state, acts) {
    const tools = q('.ar-tools');
    tools.replaceChildren(...AREA_TOOLS.map((t) => {
        const b = el('button', { type: 'button', className: `ar-tool ar-tool-${t.id}` },
            el('span', { textContent: ICON[t.id] }), el('span', { textContent: t.words }),
            el('kbd', { textContent: t.key.toUpperCase() }));
        b.dataset.tool = t.id;
        b.onclick = () => acts.tool(t.id);
        return b;
    }));
    const left = q('.ar-left');
    const kinds = el('div', {});
    const size = el('input', { type: 'number', className: 'ar-size', min: '2', max: '200',
        value: String(state.brush) });
    size.onchange = () => { state.brush = Math.min(200, Math.max(2, Number(size.value) || 20)); };
    left.append(el('div', { className: 'label', textContent: 'Kind' }), kinds,
        el('label', { className: 'ar-brush' }, 'Brush (m)', size),
        el('p', { className: 'note ar-rule', textContent: 'Two areas of the same kind that'
            + ' overlap become one on Save; a different kind cuts a hole. Anything past your'
            + ' land is clipped off.' }));
    const picker = mountKindPicker(kinds, { store: 'splatworld.areas.recent' });
    const right = q('.ar-right');
    const fields = el('div', { className: 'ar-fields' });
    const save = el('button', { type: 'button', className: 'ar-save primary',
        textContent: 'Save' });
    const said = el('p', { className: 'ar-said muted' });
    save.onclick = () => acts.save();
    right.append(el('div', { className: 'label', textContent: 'Properties' }), fields, save, said);
    return {
        picker, fields, said,
        pressed(id) {
            for (const b of tools.children) {
                b.setAttribute('aria-pressed', String(b.dataset.tool === id));
            }
        },
    };
}

// The tools' keys while Areas is open and nobody is typing.
export function areaKeys(state, acts) {
    window.addEventListener('keydown', (e) => {
        if (!state.shown() || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target?.closest?.('input, select, textarea, [contenteditable]')) return;
        const t = AREA_TOOLS.find((x) => x.key === e.key.toLowerCase());
        if (t) { e.preventDefault(); acts.tool(t.id); }
    });
}
