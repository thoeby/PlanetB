// selling.js — Marketplace › Selling (TASKS-ui.md UI.5).
//
// Your products down the left; the one you picked in the middle — what it
// sold, what it earned, how often it stands in the world, its price and the
// orders for it; and on the right, putting another one on sale in four steps
// (registerhtml.js). Changing a price and taking a product off sale are money
// code, which the payment system that replaces this one brings: both are
// drawn and greyed, and say so.

import { el } from './poolui.js';
import { thumbUrl, typeWords } from './catalog.js';
import { byDay, earnings, money, myProducts, placedCounts, salesOf } from './market.js';
import { empty } from './empty.js';
import { barChart } from './marketchart.js';
import { REGISTER_HTML } from './registerhtml.js';

export const SELLING_HTML = `
<div class="mk-selling">
  <aside class="mk-mine">
    <div class="mk-head"><span class="label">Your products</span><b class="mk-n"></b></div>
    <ul class="mk-list mk-products"></ul>
    <button type="button" class="mk-new">+ Put a model on sale</button>
  </aside>
  <main class="mk-one"></main>
  <aside class="mk-register">
    <div class="mk-head"><span class="label">Put a model on sale</span></div>
    <p class="note">From your machine: the model stays yours; buyers get licences to place
      copies.</p>
    ${REGISTER_HTML}
  </aside>
</div>`;

const WORDS = { paid: 'placed · paid', pending: 'asked · waiting for payment',
    refunded: 'refunded' };

function stat(label, value, sub, off = false) {
    return el('div', { className: off ? 'mk-stat mk-off' : 'mk-stat' },
        el('span', { className: 'label', textContent: label }),
        el('b', { textContent: value }), el('span', { className: 'muted', textContent: sub }));
}

function salesTable(rows) {
    if (!rows.length) {
        return empty('No sales yet', 'Orders for this product are listed here as they come.');
    }
    const table = el('table', { className: 'mk-table' },
        el('thead', {}, el('tr', {}, ...['When', 'Buyer', 'Qty', 'Paid to', 'Amount']
            .map((h) => el('th', { textContent: h })))));
    const body = el('tbody');
    for (const r of rows) {
        const tr = el('tr', {},
            el('td', { className: 'mono', textContent: new Date(r.created_at).toLocaleString() }),
            el('td', {}, el('b', { textContent: r.buyer_name }),
                el('div', { className: 'muted', textContent: WORDS[r.state] ?? r.state })),
            el('td', { textContent: `×${r.qty}` }),
            el('td', { textContent: 'your wallet' }),
            el('td', { className: 'mono', textContent: `${r.state === 'paid' ? '+ ' : ''}`
                + money(r.amount) }));
        tr.dataset.state = r.state;
        body.append(tr);
    }
    table.append(body);
    return table;
}

// The product in the middle: its numbers, its price, its sales.
function drawOne(host, a, { sales, placed, earned }) {
    const sold = sales.filter((s) => s.state === 'paid');
    const units = sold.reduce((n, s) => n + s.qty, 0);
    const url = thumbUrl(a);
    const off = el('button', { type: 'button', className: 'mk-offsale',
        textContent: 'Take off sale', disabled: true,
        title: 'Comes with the new payment system' });
    const price = el('input', { type: 'number', value: money(a.price), disabled: true,
        className: 'mk-price-in' });
    host.replaceChildren(
        el('div', { className: 'mk-one-head' },
            url ? el('img', { src: url, alt: '' }) : el('div', { className: 'noshot' }),
            el('div', {}, el('h2', { textContent: a.name }),
                el('span', { className: 'muted', textContent: `yours · ${a.category}`
                    + ` · ${typeWords(a.type)} · on sale since`
                    + ` ${new Date(a.created_at).toLocaleDateString()}` })), off),
        el('div', { className: 'mk-stats' },
            stat('Sold', String(units), 'new copies'),
            stat('Earned', money(earned), 'into your wallet'),
            stat('Placed', String(placed), 'copies standing in the world'),
            stat('Resold', '0', 'on the Market · not yours to earn', true)),
        el('div', { className: 'mk-row2' },
            el('div', { className: 'mk-box' },
                el('span', { className: 'label', textContent: 'Price for new copies' }),
                el('div', { className: 'row' }, price,
                    el('button', { type: 'button', textContent: 'Save price', disabled: true })),
                el('p', { className: 'note', textContent: 'The price is set when the product'
                    + ' is registered; changing it comes with the new payment system.' })),
            el('div', { className: 'mk-box' },
                el('span', { className: 'label', textContent: `Last 14 days · ${units} sold` }),
                barChart(byDay(sold, { value: (s) => s.qty })))),
        salesTable(sales));
}

export function mountSelling(doc, { onRegisterOpen } = {}) {
    const root = doc.querySelector('.mk-selling');
    const one = root.querySelector('.mk-one');
    const state = { products: [], open: null, sales: [], placed: new Map(), earned: [] };

    const list = () => {
        const ul = root.querySelector('.mk-products');
        root.querySelector('.mk-n').textContent = String(state.products.length);
        ul.replaceChildren(...state.products.map((a) => {
            const n = state.sales.filter((s) => s.san === a.san && s.state === 'paid')
                .reduce((k, s) => k + s.qty, 0);
            const b = el('button', { type: 'button' },
                el('span', {}, el('b', { textContent: a.name }),
                    el('small', { textContent: `on sale · ${n ? `${n} sold` : 'none yet'}` })),
                el('span', { className: 'mono', textContent: money(a.price) }));
            b.setAttribute('aria-pressed', String(state.open === a.san));
            // Picking a product reads its orders again: a sale made while this
            // was open is not in what was read when it opened.
            b.onclick = () => { state.open = a.san; refresh(); };
            return el('li', {}, b);
        }));
    };

    function show(san) {
        state.open = san;
        const a = state.products.find((x) => x.san === san);
        if (!a) {
            one.replaceChildren(empty('Nothing on sale yet', 'Put a model on sale on the right:'
                + ' bring the .glb, say what it does, name and price it.'));
        } else {
            drawOne(one, a, { sales: state.sales.filter((s) => s.san === san),
                placed: state.placed.get(san) ?? 0,
                earned: state.earned.filter((e) => e.san === san)
                    .reduce((n, e) => n + e.amount, 0) });
        }
        list();
    }

    async function refresh() {
        state.products = await myProducts();
        const sans = state.products.map((a) => a.san);
        [state.sales, state.placed, state.earned] = await Promise.all([salesOf(sans),
            placedCounts(sans), earnings().then((e) => e.rows)]);
        show(state.open ?? state.products[0]?.san ?? null);
        return state.products;
    }
    root.querySelector('.mk-new').onclick = () => onRegisterOpen?.();
    return { refresh, show };
}
