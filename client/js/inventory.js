// inventory.js — Build › Inventory: what you can place (TASKS-ui.md UI.3).
//
// Your own products and the ones you hold a licence for, as cards with one
// button: Place. Buying and selling are the Marketplace's; this is the shelf
// you build from. Place opens the Place panel with build mode on and the
// product picked, and the camera frames it (client/js/buildframe.js).

import { el } from './poolui.js';
import { thumbUrl, typeWords } from './catalog.js';
import { assetsBySan, myProducts, myRights } from './market.js';
import { empty } from './empty.js';

const PLACEABLE = (a) => (a.type ?? 'model') === 'model';

function card(a, why, onPlace) {
    const url = thumbUrl(a);
    const shot = url ? el('img', { src: url, alt: '', loading: 'lazy' })
        : el('div', { className: 'noshot' });
    const place = el('button', { type: 'button', className: 'inv-place primary',
        textContent: 'Place' });
    place.onclick = () => onPlace(a);
    const li = el('li', { className: 'inv-card' }, shot,
        el('div', { className: 'meta' },
            el('b', { className: 'inv-name', textContent: a.name }),
            el('span', { className: 'muted', textContent:
                `${typeWords(a.type)} · ${a.category} · ${why}` })),
        place);
    li.dataset.san = a.san;
    return li;
}

export function mountInventory(host, { onPlace, openMarket }) {
    const find = el('input', { type: 'search', className: 'inv-find',
        placeholder: 'Find in your inventory' });
    const more = el('button', { type: 'button', className: 'inv-more',
        textContent: 'Get more in the Marketplace ›' });
    more.onclick = () => openMarket?.();
    const list = el('ul', { className: 'inv-cards cards' });
    const said = el('p', { className: 'inv-said status' });
    host.append(el('div', { className: 'row inv-head' }, find, more), list, said);
    let rows = [];

    const draw = () => {
        const q = find.value.trim().toLowerCase();
        const shown = rows.filter((r) => !q || r.a.name.toLowerCase().includes(q));
        list.replaceChildren(...(shown.length ? shown.map((r) => card(r.a, r.why, onPlace))
            : [empty('Nothing to place yet',
                'What you register, and what you get in the Marketplace, is here to put'
                + ' down on your land.', { as: 'li', act: 'Open the Marketplace',
                    onAct: () => openMarket?.() })]));
    };
    find.oninput = draw;

    async function refresh() {
        const [own, rights] = await Promise.all([myProducts(), myRights()]);
        const licensed = await assetsBySan(rights.map((r) => r.san)
            .filter((san) => !own.some((a) => a.san === san)));
        const since = new Map(rights.map((r) => [r.san, r.acquired_at]));
        rows = [...own.filter(PLACEABLE).map((a) => ({ a, why: 'yours' })),
            ...licensed.filter(PLACEABLE).map((a) => ({ a, why:
                `licence since ${new Date(since.get(a.san)).toLocaleDateString()}` }))];
        said.textContent = `${rows.length} to place`;
        draw();
        return rows;
    }
    return { refresh };
}
