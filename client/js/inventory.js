// inventory.js — Profile → Inventory: the things you hold (PLAN-money.md §3).
//
// A wallet is an item: held by a player or a flow, or lying where somebody
// dropped it. Held, it can be handed to another player — who takes it or
// refuses it — or dropped where you stand. Lying within reach, it can be
// picked up; on somebody's land, only by those who may build there (O1).
// Who holds a thing is the database's fact (db/0199); this asks and shows.
//
// Where you stand is what the page knows of you, so it is what "within reach"
// is measured from.

import * as api from './api.js';
import { listFlows } from './flows.js';
import { currency, drop, handOver, itemsNear, money, myItems, pickUp, take } from './wallet.js';
import { errorText, verifyFirst } from './verify.js';

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

function keeper(map, id, make) {
    if (!map.has(id)) map.set(id, make());
    return map.get(id);
}

function heldRow(i, n, ctx) {
    const to = keeper(ctx.fields, i.id, () => el('input',
        { type: 'text', placeholder: 'a player\'s name', ariaLabel: 'hand it to' }));
    const give = el('button', { type: 'button', textContent: 'Hand over' });
    give.onclick = () => ctx.act(() => handOver(i.id, to.value),
        `Handing it to ${to.value} — they take it or refuse it.`);
    const put = el('button', { type: 'button', textContent: 'Drop here' });
    put.onclick = () => ctx.act(() => drop(i.id, ctx.where()), 'It lies where you stood.');
    // M6: a flow on land you build on can hold it — a till, a bank.
    const flow = keeper(ctx.fields, `f${i.id}`, () => el('select', { ariaLabel: 'flow' }));
    const was = flow.value;
    flow.replaceChildren(...ctx.flows.map((f) => el('option',
        { value: f.id, textContent: f.name })));
    if (was) flow.value = was;
    const toFlow = el('button', { type: 'button', textContent: 'Give to flow',
        hidden: !ctx.flows.length });
    flow.hidden = !ctx.flows.length;
    toFlow.onclick = () => ctx.act(
        () => api.rpc('give_to_flow', { item: i.id, flow: flow.value }),
        `The flow ${flow.selectedOptions[0]?.textContent ?? ''} holds it now.`);
    const end = el('div', { className: 'end' });
    if (i.offered_to) {
        const back = el('button', { type: 'button', textContent: 'Keep it' });
        back.onclick = () => ctx.act(() => handOver(i.id, ''), 'You keep it.');
        end.append(el('span', { className: 'muted',
            textContent: `handing to ${i.offered_to}` }), back);
    } else {
        end.append(to, give, put, flow, toFlow);
    }
    return el('li', { className: 'inv-held' },
        el('div', { className: 'who' },
            el('div', { className: 'name', textContent: `Wallet ${n + 1}` }),
            el('div', { className: 'sub', textContent: `${money(i.balance)} ${ctx.unit}` })),
        end);
}

function offeredRow(i, ctx) {
    const yes = el('button', { type: 'button', className: 'primary', textContent: 'Take it' });
    const no = el('button', { type: 'button', textContent: 'Refuse' });
    yes.onclick = () => ctx.act(() => take(i.id, true), 'You hold it now.');
    no.onclick = () => ctx.act(() => take(i.id, false), 'Refused.');
    return el('li', { className: 'inv-offered' },
        el('div', { className: 'who' },
            el('div', { className: 'name', textContent: `${i.offered_by} hands you a wallet` })),
        el('div', { className: 'end' }, yes, no));
}

function flowRow(f, w, n, ctx) {
    const back = el('button', { type: 'button', textContent: 'Take back' });
    back.onclick = () => ctx.act(() => api.rpc('take_from_flow', { item: w.id }),
        'You hold it again.');
    return el('li', { className: 'inv-flow' },
        el('div', { className: 'who' },
            el('div', { className: 'name', textContent: `The flow ${f.name}` }),
            el('div', { className: 'sub', textContent: `Wallet ${n + 1} · ${money(w.balance)}` })),
        el('div', { className: 'end' }, back));
}

function lyingRow(i, ctx) {
    const up = el('button', { type: 'button', textContent: 'Pick up' });
    up.onclick = () => ctx.act(() => pickUp(i.id, ctx.where()), 'You hold it now.');
    return el('li', { className: 'inv-lying' },
        el('div', { className: 'who' },
            el('div', { className: 'name', textContent: 'A wallet on the ground' }),
            el('div', { className: 'sub', textContent: `${i.metres} m away`
                + `${i.safe ? ' · on somebody\'s land' : ''}` })),
        el('div', { className: 'end' }, up));
}

export function mountInventory(host, { where = () => null, open = () => {},
    onChange = () => {} } = {}) {
    const held = el('ul', { className: 'rows inv-list' });
    const near = el('ul', { className: 'rows inv-near' });
    const status = el('p', { className: 'status inv-status' });
    host.append(el('div', { className: 'inventory' },
        el('span', { className: 'label', textContent: 'You hold' }), held,
        el('span', { className: 'label', textContent: 'Near you' }), near, status));
    const state = { lying: [], drawn: '' };
    const ctx = { fields: new Map(), unit: '', flows: [], where: () => where() ?? {} };
    ctx.act = async (fn, done) => {
        try {
            await fn();
            status.textContent = done;
            status.dataset.bad = '';
        } catch (err) {
            if (/Verify first/.test(errorText(err))) verifyFirst(status, open, errorText(err));
            else { status.textContent = errorText(err); status.dataset.bad = '1'; }
        }
        state.drawn = '';
        await refresh();
        onChange();
    };

    async function refresh() {
        ctx.unit = await currency();
        const here = where();
        const [mine, lying, flows] = await Promise.all([
            api.userId() ? myItems() : [],
            here ? itemsNear(here) : [],
            api.userId() ? listFlows().catch(() => []) : []]);
        ctx.flows = flows;
        const byFlow = await Promise.all(flows.map((f) => api.rpc('flow_wallets', { flow: f.id })
            .catch(() => []).then((ws) => ws.map((w, n) => ({ f, w, n })))));
        state.lying = lying;
        const seen = JSON.stringify([mine, lying.map((i) => [i.id, Math.round(i.metres)]),
            flows.map((f) => f.id), byFlow]);
        if (seen === state.drawn) return;
        state.drawn = seen;
        const wallets = mine.filter((i) => i.held);
        held.replaceChildren(...wallets.map((i, n) => heldRow(i, n, ctx)),
            ...mine.filter((i) => !i.held).map((i) => offeredRow(i, ctx)),
            ...byFlow.flat().map(({ f, w, n }) => flowRow(f, w, n, ctx)));
        if (!held.children.length) {
            held.append(el('li', { className: 'muted', textContent: 'Nothing.' }));
        }
        near.replaceChildren(...(lying.length ? lying.map((i) => lyingRow(i, ctx))
            : [el('li', { className: 'muted', textContent: 'Nothing lies near you.' })]));
    }

    setInterval(refresh, 3000);
    refresh();
    return { refresh, lying: () => state.lying };
}
