// renderpool.js — the Render pool panel (design 3f): what this machine can do,
// every tile waiting to be compiled, what each pays, and the one button that
// takes it. claim_for hands out the work and the escrow pays on publish
// (db/0043_pool.sql); this panel decides nothing.

import * as api from './api.js';
import { setBounty } from './wallet.js';
import { DOING, cr, el, poolRow, what } from './poolui.js';
import { empty } from './empty.js';

export function mountPool(host, { loop, where = () => ({}) } = {}) {
    const ui = poolParts(host);
    const state = { rows: [], held: [], sort: 'Nearest', caps: null, picked: null };
    const say = (msg, bad = false) => {
        ui.status.textContent = msg;
        ui.status.dataset.bad = bad ? '1' : '';
    };

    const acts = {
        render: (entry, button) => render(entry, button),
        retry: (entry, button) => retry(entry, button),
        pick: (entry) => { state.picked = entry.job; draw(); },
    };

    const draw = () => {
        drawPool(ui, state, acts, draw);
        ui.price.replaceChildren(...priceCard(state, say, refresh));
    };

    const render = (entry, button) => runJob(entry, button,
        { loop, say, refresh });

    // Hand the pieces that gave up back to whoever will take them. The person
    // pressing this is the one whose ground it is; nothing is retried on its
    // own, because three failures in a row usually mean something to fix.
    async function retry(entry, button) {
        button.disabled = true;
        try {
            const n = await api.rpc('retry_job', { job_id: entry.job });
            say(n ? `${entry.z}/${entry.x}/${entry.y}: ${n} piece(s) to try again`
                : 'nothing to try again');
        } catch (err) {
            say(String(err.body?.message ?? err.message ?? err), true);
        }
        await refresh();
    }

    async function refresh() {
        const { lon, lat } = where() ?? {};
        state.rows = await api.rpc('render_pool',
            { lon: lon ?? null, lat: lat ?? null, limit: 60 }).catch(() => []);
        // Why the list is short, when it is. A job the pool hides on purpose
        // is a job somebody who has just approved something is looking for
        // (db/0082_whythepoolisempty.sql).
        state.held = state.rows.length
            ? [] : await api.rpc('pool_held_back', { limit_: 12 }).catch(() => []);
        // What this machine is, asked once and only when the panel is open:
        // probing the adapter is the slowest part of mounting anything.
        state.caps ??= (await loop?.().catch(() => null))?.caps ?? null;
        draw();
        return state.rows;
    }

    refresh();
    return { refresh, render, retry };
}

// One job, taken out of the pool by the player who pressed Render: claim, run,
// upload, submit, until this tab has nothing left it can do on it.
async function runJob(entry, button, { loop, say, refresh }) {
    const work = await loop();
    if (!work) { say('nothing here can render', true); return; }
    if (!api.token()) { say('sign in first — the work is paid for', true); return; }
    button.disabled = true;
    const tile = `${entry.z}/${entry.x}/${entry.y}`;
    say(`rendering ${tile}… ${what(entry)}`);
    work.focus(entry.job);
    // SPEC §3.7: assembling… framing… training… published. The atom the loop
    // is on is what this tab is doing, and a compile is minutes long: a panel
    // that says nothing until the end says nothing at all.
    const watch = setInterval(() => {
        const op = work.atom?.op;
        if (op) say(`${tile} · ${DOING[op] ?? op}…`);
    }, 500);
    try {
        let step = await work.step();
        while (step) step = await work.step();
        say(await landed(tile, entry));
    } catch (err) {
        say(String(err.message ?? err), true);
    } finally {
        clearInterval(watch);
        work.focus(null);
        button.disabled = false;
        await refresh();
    }
}

// What the world says about the tile afterwards, not what this tab hoped:
// publish_tile is a compare-and-swap, and losing it is a thing to be told.
async function landed(tile, entry) {
    const [row] = await api.select('tile',
        { z: `eq.${entry.z}`, x: `eq.${entry.x}`, y: `eq.${entry.y}`,
            select: 'published_version' }).catch(() => []);
    return Number(row?.published_version ?? 0) >= Number(entry.version)
        ? `${tile} is published`
        : `${tile} is done as far as this tab can take it`;
}

function poolParts(host) {
    const ui = {
        head: el('div', { className: 'spread' }),
        list: el('ul', { className: 'rows po-list' }),
        price: el('div', { className: 'section po-price' }),
        status: el('p', { className: 'po-status status' }),
    };
    host.append(ui.head, ui.list, ui.price, ui.status);
    return ui;
}

// What to pay for one tile in the queue, on the tile you picked out of it.
//
// This was on the wallet panel, where nothing ever told it which tile was
// meant: `target()` was never called from anywhere, so it showed "no tile in
// front of you" for the life of the page and there was no way to make it show
// anything else. A price is a thing you put on a job in the queue, so it lives
// beside the queue.
function priceCard(state, say, refresh) {
    const row = state.rows.find((r) => r.job === state.picked);
    if (!row) {
        return [empty('No tile picked',
            'Pick one out of the queue above and you can offer to have it'
            + ' compiled sooner. The money is held until the tile publishes.')];
    }
    const amount = el('input', { type: 'number', min: '0', step: '1', value: '10',
        className: 'po-amount' });
    const set = el('button', { type: 'button', className: 'po-set primary',
        textContent: 'Raise the price' });
    set.onclick = async () => {
        set.disabled = true;
        try {
            await setBounty(row.job, Number(amount.value));
            say('held until the tile publishes');
        } catch (err) {
            say(String(err.body?.message ?? err.message ?? err), true);
        }
        set.disabled = false;
        await refresh();
    };
    return [
        el('span', { className: 'label',
            textContent: `What to pay for ${row.z}/${row.x}/${row.y}` }),
        el('div', { className: 'row' }, amount, set),
        el('div', { className: 'note',
            textContent: `It pays ${cr(row.bounty)} cr now. What you add is held`
                + ' from your credits until the tile publishes, and is then'
                + ' shared out by the time each tab reported.' }),
    ];
}

// An empty pool with jobs behind it is the thing that reads as "my approval
// did nothing". Each one says which of the three reasons it is.
function nothingWaiting(held) {
    if (!held?.length) {
        return [empty('The pool is clear',
            'Every tile anybody submitted is compiled. Jobs appear here the'
            + ' moment somebody submits land.', { as: 'li' })];
    }
    return [
        empty('Nothing can be taken yet',
            `${held.length} tile(s) are open and waiting on something else:`,
            { as: 'li' }),
        ...held.map((h) => el('li', { className: 'po-held' },
            el('div', { className: 'who' },
                el('div', { className: 'name', textContent: `${h.z}/${h.x}/${h.y}` }),
                el('div', { className: 'sub', textContent: h.why })))),
    ];
}

function drawPool(ui, state, acts, draw) {
    ui.head.replaceChildren(
        el('span', { className: 'label',
            textContent: `${state.rows.length} waiting to be compiled` }),
        el('div', { className: 'row' }, ...['Nearest', 'Best pay'].map((key) => {
            const b = el('button', { type: 'button', textContent: key });
            if (key === state.sort) b.dataset.on = '1';
            b.onclick = () => { state.sort = key; draw(); };
            return b;
        })));
    // Nearest is what somebody is waiting to walk on; best pay is what a
    // stranger's tab is looking for. render_pool already ordered by pay.
    const rows = state.sort === 'Best pay'
        ? [...state.rows].sort((a, b) => Number(b.bounty) - Number(a.bounty))
        : [...state.rows].sort((a, b) => (a.metres ?? 0) - (b.metres ?? 0));
    ui.list.replaceChildren(
        ...rows.map((r) => poolRow(r, acts, state.caps, state.picked)));
    if (!rows.length) ui.list.append(...nothingWaiting(state.held));
}
