// shop.js — Marketplace › Shop (TASKS-ui.md UI.4).
//
// Products made by players, found by kind, by maker and by name, sorted the
// three ways a buyer asks (newest, cheapest, most placed), and bought from the
// column on the right: how many, paid from which wallet. An order is one
// transaction on the database's side (Invariant 5, db/0206); this asks and
// says what it answered. The Market of used licences is drawn and greyed: it
// comes with the payment system that replaces this one.

import * as api from './api.js';
import { el } from './poolui.js';
import { TYPES, glbUrl, policyWords, thumbUrl, typeWords } from './catalog.js';
import { myAccount, offerOf, orderAsset } from './wallet.js';
import { installRow, mayInstall } from './catalogplugin.js';
import { detailOf } from './catalogdetail.js';
import { money, myRights, placedCounts, shopProducts } from './market.js';
import { empty } from './empty.js';

export const SHOP_HTML = `
<div class="mk-shop">
  <aside class="mk-filters">
    <span class="label">Category</span>
    <ul class="mk-list mk-cats"></ul>
    <span class="label">Maker</span>
    <ul class="mk-list mk-makers"></ul>
    <label class="mk-sel">What it is <select id="type"></select></label>
    <label class="mk-sel">Licence <select id="license"></select></label>
    <select id="category" hidden></select>
    <label class="row-switch mk-off" title="Comes with the new payment system">
      <span>Only new from the maker</span><input type="checkbox" checked disabled>
    </label>
  </aside>
  <main class="mk-main">
    <div class="mk-search">
      <input id="q" type="search" placeholder="Find a product">
      <button id="refresh" type="button">Find</button>
      <span class="label">Sort</span>
      <div class="mk-seg" role="group" aria-label="sort">
        <button type="button" data-sort="newest" aria-pressed="true">Newest</button>
        <button type="button" data-sort="cheapest">Cheapest</button>
        <button type="button" data-sort="placed">Most placed</button>
      </div>
      <span class="mk-count muted"></span>
    </div>
    <ul id="results" class="mk-cards"></ul>
  </main>
  <section id="detail" class="mk-detail" hidden></section>
</div>`;

const SORTS = {
    newest: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
    cheapest: (a, b) => Number(a.price) - Number(b.price),
    placed: (a, b) => (b.placed ?? 0) - (a.placed ?? 0),
};

function shot(a, big = false) {
    const url = thumbUrl(a);
    return url ? el('img', { src: url, alt: big ? '' : a.name, loading: 'lazy',
        className: big ? 'big' : '' })
        : el('div', { className: big ? 'noshot big' : 'noshot' });
}

// One product card: the picture with its kind, the name (the button that opens
// it), who made it and how often it stands in the world, and the price.
function card(a, state, open, buy) {
    const offer = offerOf(a, state.held.has(a.san));
    const mine = a.creator_id === api.userId();
    const act = el('button', { type: 'button', className: 'mk-buy',
        textContent: mine ? 'Yours' : offer.state === 'held' ? 'Held'
            : offer.state === 'sold_out' ? 'Sold out' : 'Buy',
        disabled: mine || offer.state !== 'buy' || !api.claims() });
    act.onclick = () => buy(a, 1);
    const name = el('button', { type: 'button', className: 'mk-name', textContent: a.name });
    name.onclick = () => open(a.san);
    const li = el('li', { className: 'mk-card' },
        el('div', { className: 'mk-shot' }, shot(a),
            el('span', { className: 'mk-tag', textContent: a.category })),
        el('div', { className: 'meta' }, name,
            el('span', { className: 'muted', textContent:
                `${state.makers.get(a.creator_id) ?? 'somebody'} · placed ${a.placed ?? 0}×` }),
            el('div', { className: 'mk-price' },
                el('b', { textContent: money(a.price) }),
                el('span', { className: 'muted', textContent: Number(a.price) ? 'new' : 'free' }),
                act),
            el('span', { className: 'mk-off-line', textContent: 'none on the Market' }),
            el('span', { className: 'san mono muted', textContent: a.san })));
    li.dataset.san = a.san;
    li.setAttribute('aria-current', String(state.open === a.san));
    return li;
}

function priceRow(a) {
    const cell = (k, v, off = false) => el('div', { className: off ? 'mk-off' : '' },
        el('span', { className: 'label', textContent: k }), el('b', { textContent: v }));
    return el('div', { className: 'mk-prices' }, cell('New', money(a.price)),
        cell('Market', '—', true), cell('Last', '—', true));
}

// The right-hand column: what it is, how often it is placed, how many you
// hold, and buying it — how many, from which wallet.
async function detail(host, a, state, buy) {
    const account = await myAccount();
    const holds = state.held.has(a.san);
    const qty = el('input', { type: 'number', min: '1', max: '120', value: '1',
        className: 'mk-qty' });
    qty.setAttribute('aria-label', 'how many');
    const offer = offerOf(a, holds);
    const mine = a.creator_id === api.userId();
    const go = el('button', { type: 'button', className: 'buy primary',
        textContent: offer.state === 'buy' ? `Buy new · ${money(a.price)}` : offer.label,
        disabled: mine || offer.state !== 'buy' || !api.claims() });
    go.onclick = () => buy(a, Number(qty.value) || 1);
    const market = el('button', { type: 'button', className: 'mk-market',
        textContent: 'Take the market offer', disabled: true,
        title: 'Comes with the new payment system' });
    host.replaceChildren(shot(a, true),
        el('h2', { textContent: a.name }),
        el('p', { className: 'muted', textContent: `${state.makers.get(a.creator_id)
            ?? 'somebody'} · ${a.category} · ${typeWords(a.type)} · placed`
            + ` ${a.placed ?? 0}× in the world${holds ? ' · you hold a licence' : ''}` }),
        priceRow(a),
        el('label', { className: 'mk-sel', textContent: 'How many' }, qty),
        el('label', { className: 'mk-sel', textContent: 'Pay from' },
            el('select', { disabled: !account },
                new Option(account ? `Wallet · ${money(account.amount)}` : 'Sign in first'))),
        go, market,
        el('p', { className: 'note', textContent: `${policyWords(a)} The maker's price is paid`
            + ' from your wallet and the licence is handed to you. One licence places one'
            + ' copy.' }),
        el('p', { id: 'status', className: 'status' }),
        el('details', { className: 'mk-more' }, el('summary', { textContent: 'Details' }),
            detailOf(a), el('a', { href: glbUrl(a), textContent: 'canonical glb' })),
        ...[installRow(a, mayInstall(a, state.held))].filter(Boolean));
    host.hidden = false;
}

function filterList(host, entries, chosen, pick) {
    host.replaceChildren(...entries.map(([key, label, n]) => {
        const b = el('button', { type: 'button' }, el('span', { textContent: label }),
            el('small', { textContent: String(n) }));
        b.setAttribute('aria-pressed', String(chosen === key));
        b.onclick = () => pick(key);
        return el('li', {}, b);
    }));
}

// The filters with their counts, and the cards the filters leave.
function drawShop(root, at, state, open, buy) {
    const q = at('q').value.trim().toLowerCase();
    const shown = state.all.filter((a) => (!state.cat || a.category === state.cat)
        && (!state.maker || a.creator_id === state.maker)
        && (!at('type').value || (a.type ?? 'model') === at('type').value)
        && (!at('license').value || a.license === at('license').value)
        && (!q || a.name.toLowerCase().includes(q))).sort(SORTS[state.sort]);
    const count = (fn) => state.all.filter(fn).length;
    const again = () => drawShop(root, at, state, open, buy);
    const cats = [...new Set(state.all.map((a) => a.category))].sort();
    filterList(root.querySelector('.mk-cats'), [['', 'All', state.all.length],
        ...cats.map((c) => [c, c, count((a) => a.category === c)])], state.cat,
    (k) => { state.cat = k; again(); });
    filterList(root.querySelector('.mk-makers'), [['', 'All', state.all.length],
        ...[...state.makers].map(([id, name]) => [id, id === api.userId() ? 'you' : name,
            count((a) => a.creator_id === id)])], state.maker,
    (k) => { state.maker = k; again(); });
    at('results').replaceChildren(...(shown.length
        ? shown.map((a) => card(a, state, open, buy))
        : [empty('Nothing in the shop', 'Products players put on sale are here to buy.'
            + ' Put your own on sale under Selling.', { as: 'li' })]));
    root.querySelector('.mk-count').textContent = `${shown.length} products`;
}

function sortButtons(root, state, draw) {
    for (const b of root.querySelectorAll('[data-sort]')) {
        b.onclick = () => {
            state.sort = b.dataset.sort;
            for (const x of root.querySelectorAll('[data-sort]')) {
                x.setAttribute('aria-pressed', String(x === b));
            }
            draw();
        };
    }
}

export function mountShop(doc, { choices } = {}) {
    const at = (id) => doc.getElementById(id);
    const root = doc.querySelector('.mk-shop');
    const state = { all: [], held: new Set(), makers: new Map(), cat: '', maker: '',
        sort: 'newest', open: null };
    at('type').replaceChildren(new Option('any', ''),
        ...TYPES.map((t) => new Option(t.words, t.id)));
    at('license').replaceChildren(new Option('any', ''),
        ...(choices?.licences ?? []).map((v) => new Option(v, v)));

    const draw = () => drawShop(root, at, state, open, buy);

    async function open(san) {
        state.open = san;
        const a = state.all.find((x) => x.san === san);
        if (a) await detail(at('detail'), a, state, buy);
        draw();
    }

    async function buy(a, qty) {
        try {
            const order = await orderAsset(a.san, qty);
            await refresh();
            await open(a.san);
            at('status').textContent = order.state === 'paid' ? `licensed ${a.san}`
                : order.pay_url ? `ordered ${a.san}: pay at ${order.pay_url}`
                    : `ordered ${a.san}: waiting for ${order.provider}`;
        } catch (err) {
            await open(a.san);
            at('status').textContent = String(err.body?.message ?? err.message ?? err);
        }
    }

    async function refresh() {
        const [all, rights] = await Promise.all([shopProducts().catch(() => []), myRights()]);
        const placed = await placedCounts(all.map((a) => a.san));
        state.all = all.map((a) => ({ ...a, placed: placed.get(a.san) ?? 0 }));
        state.held = new Set(rights.map((r) => r.san));
        for (const id of new Set(all.map((a) => a.creator_id))) {
            if (!state.makers.has(id)) {
                state.makers.set(id, await api.rpc('player_name', { who: id })
                    .catch(() => 'somebody'));
            }
        }
        draw();
        return state.all;
    }

    sortButtons(root, state, draw);
    at('refresh').onclick = refresh;
    at('q').addEventListener('change', draw);
    at('type').addEventListener('change', draw);
    at('license').addEventListener('change', draw);
    return { refresh, open };
}
