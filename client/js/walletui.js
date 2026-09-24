// walletui.js — the Wallet panel: the cash in the wallet you hold, what it
// has done, and the two things a wallet does from here: Pay and Request
// (PLAN-money.md M4). Handing it over and dropping it are the Inventory's.
//
// The balance is what the wallet itself last said (walletd writes it down);
// only its holder sees it. What this panel sends is an ask — whether the cash
// moves is the wallet's answer, and the panel shows it as it comes.
//
// The fields are made once and never redrawn (HANDOFF §2); the lists are
// redrawn only when what they say has changed.

import * as api from './api.js';
import { answer, currency, history, money, myItems, pay, request } from './wallet.js';
import { errorText, verifyFirst } from './verify.js';

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n))}`;
const when = (at) => (at ? new Date(at).toLocaleString(undefined,
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

const STATE = { queued: 'on its way', asked: 'asked', confirmed: 'being paid',
    held: 'held', releasing: 'coming back', done: '', returned: 'came back',
    failed: 'did not go through', refused: 'refused' };

function field(label, props) {
    const input = el('input', props);
    return [input, el('label', {}, el('span', { textContent: label }), input)];
}

// One form: who, how much, and what for.
function form(name, verb, whoLabel, act) {
    const [who, wl] = field(whoLabel, { type: 'text', placeholder: 'a player\'s name' });
    const [amount, al] = field('amount', { type: 'number', min: '0.01', step: '0.01' });
    const [note, nl] = field(name === 'pay' ? 'message' : 'what for', { type: 'text' });
    const go = el('button', { type: 'button', className: 'primary', textContent: verb });
    go.onclick = () => act({ who: who.value, amount: Number(amount.value), note: note.value });
    return el('div', { className: `section wallet-${name}` },
        el('span', { className: 'label', textContent: verb }), wl, al, nl, go);
}

function row(h, act) {
    const kids = [el('div', { className: 'who' },
        el('div', { className: 'name', textContent: h.with }),
        el('div', { className: 'sub', textContent: [h.message, STATE[h.state], h.said]
            .filter(Boolean).join(' · ') }))];
    const end = el('div', { className: 'end' },
        el('span', { className: 'amount', textContent: signed(Number(h.amount)),
            style: `color: var(--${Number(h.amount) > 0 ? 'accent' : 'ink'})` }),
        el('span', { className: 'muted', textContent: when(h.at) }));
    if (h.asks_me) {
        const yes = el('button', { type: 'button', className: 'primary', textContent: 'Pay' });
        const no = el('button', { type: 'button', textContent: 'Refuse' });
        yes.onclick = () => act(() => answer(h.id, true), 'Paying.');
        no.onclick = () => act(() => answer(h.id, false), 'Refused.');
        end.append(yes, no);
    }
    return el('li', { className: `wallet-row${h.asks_me ? ' wallet-ask' : ''}` }, ...kids, end);
}

export function mountWallet(host, { onBalance = () => {}, open = () => {} } = {}) {
    const pick = el('select', { className: 'wallet-pick', ariaLabel: 'wallet' });
    const totals = el('div', { className: 'tiles' });
    const status = el('p', { className: 'wallet-status status' });
    const rows = el('ul', { className: 'rows wallet-history' });
    const state = { items: [], wallet: null, drawn: '', unit: '' };
    const say = (msg, bad = false) => Object.assign(status,
        { textContent: msg }).dataset.bad = bad ? '1' : '';
    const act = async (fn, done) => {
        try {
            await fn();
            say(done);
        } catch (err) {
            if (/Verify first/.test(errorText(err))) verifyFirst(status, open, errorText(err));
            else say(errorText(err), true);
        }
        refresh();
    };
    const forms = el('div', { className: 'wallet-forms' },
        form('pay', 'Pay', 'pay to', ({ who, amount, note }) => act(
            () => pay(state.wallet, who, amount, note), `Paying ${who} ${money(amount)}.`)),
        form('request', 'Request', 'ask', ({ who, amount, note }) => act(
            () => request(state.wallet, who, amount, note), `Asked ${who} for ${money(amount)}.`)));
    const none = el('p', { className: 'muted wallet-none' });
    host.append(el('div', { className: 'wallet' }, pick, totals, none, forms, status,
        el('span', { className: 'label', textContent: 'What moved' }), rows));
    pick.onchange = () => { state.wallet = pick.value; state.drawn = ''; refresh(); };

    async function refresh() {
        const signedIn = Boolean(api.userId());
        state.unit = await currency();
        state.items = signedIn
            ? (await myItems()).filter((i) => i.kind === 'wallet' && i.held) : [];
        if (!state.items.some((i) => i.id === state.wallet)) {
            state.wallet = state.items[0]?.id ?? null;
        }
        const w = state.items.find((i) => i.id === state.wallet) ?? null;
        drawTotals(totals, w, state.unit);
        drawPick(pick, state);
        forms.hidden = !w;
        none.hidden = Boolean(w);
        none.textContent = signedIn ? 'You hold no wallet. A verified player is given one'
            + ' with the starting amount; a wallet can also be handed to you, or picked up.'
            : 'Sign in to see your wallet.';
        const h = w ? await history(w.id) : [];
        const seen = JSON.stringify(h);
        if (seen !== state.drawn) {
            state.drawn = seen;
            rows.replaceChildren(...(h.length ? h.map((x) => row(x, act)) : [el('li',
                { className: 'muted', textContent: w ? 'Nothing has moved yet.' : '' })]));
        }
        onBalance(w ? { amount: w.balance, unit: state.unit } : null);
        return w;
    }

    // The balance on the bar follows the wallet whether the panel is open or not.
    setInterval(refresh, 4000);
    refresh();
    return { refresh, state, say };
}

function drawPick(pick, state) {
    pick.hidden = state.items.length < 2;
    pick.replaceChildren(...state.items.map((i, n) => el('option', { value: i.id,
        textContent: `Wallet ${n + 1} · ${money(i.balance)}`, selected: i.id === state.wallet })));
}

function drawTotals(host, w, unit) {
    if (!w) { host.replaceChildren(); return; }
    host.replaceChildren(
        // .wallet-balance is what anything outside this panel looks for.
        el('div', { className: 'tile wallet-balance' },
            el('div', { className: 'v', textContent: money(w.balance) }),
            el('div', { className: 'l', textContent: `${unit || 'cash'} in this wallet` })),
        el('div', { className: 'tile' },
            el('div', { className: 'v', textContent: w.pending ? 'yes' : 'no' }),
            el('div', { className: 'l', textContent: 'on its way' })));
}
