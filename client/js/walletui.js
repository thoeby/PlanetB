// walletui.js — the wallet panel (design 3h): what you have, what is held
// against work you asked for, what you paid, what you earned, and every
// movement that touched your account.
//
// A bounty is escrowed the moment it is set (db/0006_publish.sql) and paid out
// pro rata by reported GPU time when the tile publishes. That is why "held"
// is its own number and not part of "paid": the money is out of the wallet and
// not yet anybody else's.

import * as api from './api.js';
import { myAccount, myLedger, setBounty } from './wallet.js';

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

const cr = (n) => (Number(n) || 0).toFixed(2);
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${cr(Math.abs(n))}`;

// The ref is the world's own word for what a movement was for
// (bounty:{job}, pay:{job}:{worker}, buy:{san}:{user}).
const WORDS = {
    bounty: 'Held · render pool',
    pay: 'Rendered a tile',
    buy: 'Product licence',
    topup: 'Added credits',
    refund: 'Returned · render pool',
};

function title(row) {
    const kind = String(row.ref ?? '').split(':')[0];
    const words = WORDS[kind];
    if (words) return row.delta > 0 && kind === 'pay' ? 'Earned · rendered a tile' : words;
    return row.delta > 0 ? 'Earned' : 'Paid';
}

const when = (at) => (at
    ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    : '');

const tile = (v, l, tone) => el('div', { className: 'tile', 'data-tone': tone ?? '' },
    el('div', { className: 'v', textContent: v }),
    el('div', { className: 'l', textContent: l }));

// What the pool still owes back: the bounties on jobs that are open, which are
// the ones this wallet is holding money against.
function heldFor(rows, open) {
    const jobs = new Set((open ?? []).map((j) => String(j.job)));
    let held = 0;
    let n = 0;
    for (const r of rows) {
        const [kind, job] = String(r.ref ?? '').split(':');
        if (kind === 'bounty' && jobs.has(job)) {
            held += Math.abs(r.delta);
            n += 1;
        }
    }
    return { held, n };
}

export function mountWallet(host, { onBalance = () => {} } = {}) {
    const totals = el('div', { className: 'tiles' });
    const head = el('div', { className: 'spread' });
    const rows = el('ul', { className: 'rows' });
    const bounty = el('div', { className: 'section' });
    const status = el('p', { className: 'wallet-status status' });
    host.append(totals, bounty, head, rows, status);

    const state = { account: null, job: null, tile: null, rows: [], open: [], filter: 'All' };
    const say = (msg, bad = false) => {
        status.textContent = msg;
        status.dataset.bad = bad ? '1' : '';
    };

    const draw = () => {
        drawTotals(totals, state);
        drawHead(head, state, draw);
        drawRows(rows, state);
        bounty.replaceChildren(...bountyCard(state, say, refresh));
    };

    async function refresh() {
        state.account = await myAccount();
        state.rows = state.account ? await myLedger(state.account.id, 60) : [];
        state.open = await api.rpc('render_pool', { limit: 200 }).catch(() => []);
        draw();
        onBalance(state.account);
        return state.account;
    }

    // Build mode hands the panel the tile the player is looking at, so a
    // bounty is set on the job that would draw it.
    function target(t, job) {
        state.tile = t;
        state.job = job;
        draw();
        return state;
    }

    refresh();
    return { refresh, target, state, say };
}

function drawTotals(host, state) {
    if (!state.account) {
        host.replaceChildren(el('div', { className: 'muted',
            textContent: 'Sign in to see your wallet.' }));
        return;
    }
    const { held, n } = heldFor(state.rows, state.open);
    const sum = (f) => state.rows.filter(f).reduce((a, r) => a + Math.abs(r.delta), 0);
    host.replaceChildren(
        tile(cr(state.account.amount), 'credits available', 'accent'),
        tile(cr(held), `held for ${n} open job${n === 1 ? '' : 's'}`, 'warn'),
        tile(signed(-sum((r) => r.delta < 0)), 'paid'),
        tile(signed(sum((r) => r.delta > 0)), 'earned', 'accent'));
}

function drawHead(host, state, draw) {
    const chip = (f) => {
        const b = el('button', { type: 'button', textContent: f });
        if (f === state.filter) b.dataset.on = '1';
        b.onclick = () => { state.filter = f; draw(); };
        return b;
    };
    host.replaceChildren(
        el('span', { className: 'label', textContent: 'All movements' }),
        el('div', { className: 'row' }, chip('All'), chip('Paid'), chip('Earned')));
}

function drawRows(host, state) {
    const shown = state.rows.filter((r) => state.filter === 'All'
        || (state.filter === 'Earned' ? r.delta > 0 : r.delta < 0));
    host.replaceChildren(...shown.map((r) => el('li', {},
        el('div', { className: 'who' },
            el('div', { className: 'name', textContent: title(r) }),
            el('div', { className: 'sub', textContent: r.ref })),
        el('div', { className: 'end' },
            el('span', { style: `color: var(--${r.delta > 0 ? 'accent' : 'ink'})`,
                textContent: signed(r.delta) }),
            el('span', { className: 'muted', textContent: when(r.at) })))));
    if (!shown.length) {
        host.append(el('li', { className: 'muted',
            textContent: state.account ? 'Nothing has moved yet.'
                : 'Your movements are private — sign in to see them.' }));
    }
}

// The one thing the wallet does rather than reports: put a price on the tile
// you are looking at, so a stranger's browser has a reason to draw it.
function bountyCard(state, say, refresh) {
    const amount = el('input', { type: 'number', min: '0', step: '1', value: '10',
        className: 'wallet-amount' });
    const set = el('button', { type: 'button', className: 'wallet-set primary',
        textContent: 'Set the price', disabled: !state.job });
    set.onclick = async () => {
        if (!state.job) return;
        try {
            await setBounty(state.job, Number(amount.value));
            say('held until the tile publishes');
            await refresh();
        } catch (err) {
            say(String(err.body?.message ?? err.message ?? err), true);
        }
    };
    return [
        el('span', { className: 'label',
            textContent: 'What to pay for the tile you are looking at' }),
        el('div', { className: 'row' }, amount, set),
        el('div', { className: 'note',
            textContent: state.tile
                ? `${state.tile.z}/${state.tile.x}/${state.tile.y}`
                  + `${state.job ? ` · job ${state.job}` : ' · no job for it yet'}`
                : 'Look at a tile in the world and it appears here.' }),
    ];
}
