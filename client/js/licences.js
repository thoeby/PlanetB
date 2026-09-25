// licences.js — Marketplace › Licences and › Earnings (TASKS-ui.md UI.6).
//
// Licences: what you hold, since when, which version it follows, and how
// often the product stands in the world. Reselling one is the Market's, which
// comes with the payment system that replaces this one, so it is greyed.
//
// Earnings: what your products brought in — this month, as new copies, as
// resales (none until the Market exists), what is on its way (orders asked for
// and not yet paid) — the last thirty days, and the rows it came in as.

import { el } from './poolui.js';
import { assetsBySan, byDay, earnings, money, myProducts, myRights, placedCounts,
    salesOf } from './market.js';
import { empty } from './empty.js';
import { barChart } from './marketchart.js';

const FOLLOW = { current: 'follows current', legacy: 'follows legacy',
    pinned: 'this exact version' };

export function mountLicences(host) {
    const list = el('ul', { className: 'mk-licences rows' });
    host.append(el('div', { className: 'mk-head' },
        el('span', { className: 'label', textContent: 'Licences you hold' })), list);
    async function refresh() {
        const rights = await myRights();
        const assets = await assetsBySan(rights.map((r) => r.san));
        const placed = await placedCounts(rights.map((r) => r.san));
        const by = new Map(assets.map((a) => [a.san, a]));
        list.replaceChildren(...(rights.length ? rights.map((r) => {
            const a = by.get(r.san);
            const resell = el('button', { type: 'button', textContent: 'Resell',
                disabled: true, title: 'Comes with the new payment system' });
            const li = el('li', { className: 'mk-licence' },
                el('div', {}, el('b', { textContent: a?.name ?? r.san }),
                    el('div', { className: 'muted', textContent: 'since'
                        + ` ${new Date(r.acquired_at).toLocaleDateString()} ·`
                        + ` ${FOLLOW[r.follow] ?? 'follows current'}`
                        + `${r.until ? ` · until ${new Date(r.until).toLocaleDateString()}`
                            : ''} · placed ${placed.get(r.san) ?? 0}× in the world` })),
                resell);
            li.dataset.san = r.san;
            return li;
        }) : [empty('No licences yet', 'What you buy in the Shop is listed here, and is in'
            + ' your Inventory to place.', { as: 'li' })]));
        return rights;
    }
    return { refresh };
}

function tile(label, value, sub, tone = '') {
    const n = el('div', { className: 'mk-stat' },
        el('span', { className: 'label', textContent: label }),
        el('b', { textContent: value }), el('span', { className: 'muted', textContent: sub }));
    n.dataset.tone = tone;
    return n;
}

export function mountEarnings(host) {
    const tiles = el('div', { className: 'mk-stats' });
    const chart = el('div', { className: 'mk-box' });
    const rows = el('ul', { className: 'mk-came rows' });
    host.append(tiles, chart, el('div', { className: 'mk-head' },
        el('span', { className: 'label', textContent: 'Came in' })), rows);
    async function refresh() {
        const [{ rows: got }, products] = await Promise.all([earnings(), myProducts()]);
        const names = new Map(products.map((a) => [a.san, a.name]));
        const pending = (await salesOf(products.map((a) => a.san)))
            .filter((s) => s.state === 'pending');
        const month = new Date().toISOString().slice(0, 7);
        const thisMonth = got.filter((r) => String(r.at).slice(0, 7) === month);
        const sum = (xs) => xs.reduce((n, r) => n + Number(r.amount), 0);
        tiles.replaceChildren(
            tile('This month', money(sum(thisMonth)), `${thisMonth.length} payments`, 'accent'),
            tile('New copies', money(sum(got)), `${got.length} sold as the maker`),
            tile('Resales', money(0), 'the Market comes with the new payment system', 'off'),
            tile('On its way', money(sum(pending)), `${pending.length} asked, not yet paid`,
                'warn'));
        chart.replaceChildren(el('span', { className: 'label', textContent: 'Last 30 days' }),
            barChart(byDay(got, { days: 30, at: 'at', value: (r) => r.amount })));
        rows.replaceChildren(...(got.length ? got.map((r) => el('li', {},
            el('span', { className: 'mono', textContent: new Date(r.at).toLocaleString() }),
            el('b', { textContent: `${names.get(r.san) ?? r.san} · new copy` }),
            el('span', { className: 'mk-kind', textContent: 'new' }),
            el('span', { className: 'mono', textContent: `+ ${money(r.amount)}` })))
            : [empty('Nothing came in yet', 'When somebody buys one of your products, the'
                + ' payment is listed here.', { as: 'li' })]));
        return got;
    }
    return { refresh };
}
