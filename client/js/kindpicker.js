// kindpicker.js — the palette a line or an area is picked from
// (PLAN-editors.md idea 26; EDT.13, reused by Areas in EDT.20).
//
// A search box over the operator's kinds for the geometry in hand, each with
// its swatch and one line of what it becomes; the recent ones on top and the
// first nine on keys 1–9. Which kinds there are is data (client/lib/kinds.js).

import { ordered, touched } from '../lib/kinds.js';
import { el } from './tabbar.js';

export function mountKindPicker(host, { store = 'splatworld.kinds.recent', onPick } = {}) {
    let recent = [];
    try {
        recent = JSON.parse(globalThis.localStorage?.getItem(store) ?? '[]');
    } catch { recent = []; }
    const search = el('input', { type: 'search', className: 'kp-search',
        placeholder: 'kind — type to find, 1–9 to pick' });
    const list = el('ol', { className: 'kp-list' });
    host.append(el('div', { className: 'kp' }, search, list));
    const state = { entries: [], picked: null, shown: [] };

    const draw = () => {
        state.shown = ordered(state.entries, recent, search.value);
        list.replaceChildren(...state.shown.map((e, n) => {
            const li = el('li', { className: 'kp-kind' },
                el('i', { className: 'kp-swatch' }),
                el('span', { className: 'kp-words', textContent: e.words }),
                el('span', { className: 'kp-says muted', textContent: e.says }),
                el('kbd', { textContent: n < 9 ? String(n + 1) : '' }));
            li.querySelector('.kp-swatch').style.background = e.swatch;
            li.dataset.kind = e.id;
            li.setAttribute('aria-selected', String(state.picked?.id === e.id));
            li.onclick = () => pick(e);
            return li;
        }));
    };
    const pick = (e) => {
        if (!e) return null;
        state.picked = e;
        recent = touched(recent, e.id);
        try {
            globalThis.localStorage?.setItem(store, JSON.stringify(recent));
        } catch { /* nowhere to keep it */ }
        draw();
        onPick?.(e);
        return e;
    };
    search.addEventListener('input', draw);
    return {
        get picked() { return state.picked; },
        set(entries) {
            state.entries = entries;
            if (!state.picked || !entries.some((e) => e.id === state.picked.id)) {
                state.picked = ordered(entries, recent)[0] ?? null;
            }
            draw();
        },
        pick: (id) => pick(state.entries.find((e) => e.id === id)),
        // 1–9: the nth entry as the list shows it now.
        key: (n) => pick(state.shown[n - 1]),
    };
}
