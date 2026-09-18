// renderpool.js — the Render pool panel (design 3f): what this machine can do,
// every tile waiting to be compiled, what each pays, and the one button that
// takes it. claim_for hands out the work and the escrow pays on publish
// (db/0043_pool.sql); this panel decides nothing.

import * as api from './api.js';
import { setBounty } from './wallet.js';
import { DOING, cr, drawnWhen, el, what } from './poolui.js';
import { phaseTabs, pager, poolCard } from './poolcard.js';
import { empty } from './empty.js';

const said = (err) => String(err?.body?.message ?? err?.message ?? err);

// Cards on a page. Enough to scroll through, few enough that the page after
// this one is a press away rather than a scroll to the bottom of everything.
const PAGE = 12;

export function mountPool(host, { loop, where = () => ({}) } = {}) {
    const ui = poolParts(host);
    // A page of one kind of work at a time (db/0146 pool_page). `page` is
    // what the server answered: its rows, how many there are of this kind,
    // and how many of each kind there are altogether.
    const state = { page: null, rows: [], held: [], phase: 'render',
        offset: 0, caps: null, picked: null };
    const say = (msg, bad = false) => {
        ui.status.textContent = msg;
        ui.status.dataset.bad = bad ? '1' : '';
    };

    const acts = {
        render: (entry, button) => render(entry, button),
        retry: (entry, button) => retry(entry, button),
        drop: (entry, button) => drop(entry, button),
        pick: (entry) => { state.picked = entry.job; draw(); },
        redo: (entry, button) => redo(entry, button),
        look: (phase) => look(phase),
        turn: (offset) => turn(offset),
    };

    // Which kind of work, and which page of it. Both reset the other: a page
    // number means nothing across two different lists.
    const look = (phase) => { state.phase = phase; state.offset = 0; refresh(); };
    const turn = (offset) => { state.offset = offset; refresh(); };

    const draw = () => {
        try {
            drawPool(ui, state, acts, draw);
            ui.price.replaceChildren(...priceCard(state, say, refresh));
        } catch (err) {
            say(`the pool could not be drawn: ${said(err)}`, true);
            console.error(err);
        }
    };

    const render = (entry, button) => runJob(entry, button,
        { loop, say, refresh });

    // Start a job that gave up over from its first atom, or take it out of the
    // pool. The person pressing either is the one whose ground it is; nothing
    // is retried on its own, because three failures usually mean something
    // to fix, and a job the tool cannot finish does not sit there for ever.
    const retry = (entry, button) => ask(entry, button, 'retry_job',
        (n) => (n ? `${n} piece(s) start over` : 'nothing to try again'));
    const drop = (entry, button) => ask(entry, button, 'drop_job',
        (gone) => (gone ? 'dropped from the pool' : 'nothing to drop'));
    // The frames are what a tile was trained on, so a tile trained against
    // the wrong ones is put right by asking for them again (db/0147). The
    // training goes back to waiting; nothing is unmade.
    const redo = (entry, button) => ask(entry, button, 'redo_renders',
        (n) => (n ? `${n} frame(s) will be drawn again, and the training after them`
            : 'this tile has no frames of its own'));
    async function ask(entry, button, fn, said) {
        button.disabled = true;
        try {
            const r = await api.rpc(fn, { job_id: entry.job });
            say(`${entry.z}/${entry.x}/${entry.y}: ${said(r)}`);
        } catch (err) {
            say(String(err.body?.message ?? err.message ?? err), true);
        }
        await refresh();
    }

    // A pool that cannot be read says so in its own line; an empty list is
    // the answer "nothing is waiting", never the answer "the question failed".
    async function refresh() {
        const { lon, lat } = where() ?? {};
        state.page = await api.rpc('pool_page',
            { lon: lon ?? null, lat: lat ?? null, phase: state.phase,
                limit: PAGE, offset: state.offset })
            .catch((err) => { say(`could not read the pool: ${said(err)}`, true); return null; });
        state.rows = state.page?.rows ?? [];
        // A page past the end of a list that shrank while it was being looked
        // at is an empty panel with tiles behind it; step back to the last one.
        if (!state.rows.length && state.offset > 0) {
            state.offset = Math.max(0, Math.floor(
                (Number(state.page?.total ?? 1) - 1) / PAGE) * PAGE);
            return refresh();
        }
        state.held = state.rows.length
            ? [] : await api.rpc('pool_held_back', { limit_: 12 }).catch(() => []);
        // What this machine is, asked once and only when the panel is open:
        // probing the adapter is the slowest part of mounting anything.
        state.caps ??= (await loop?.().catch(() => null))?.caps ?? null;
        draw();
        return state.rows;
    }

    refresh();
    return { refresh, render, retry, drop };
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
    let refreshed = false;
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
        const rows = await refresh();
        say(await landed(tile, entry, rows, work.caps));
        refreshed = true;
    } catch (err) {
        say(String(err.message ?? err), true);
    } finally {
        clearInterval(watch);
        work.focus(null);
        button.disabled = false;
        if (!refreshed) await refresh();
    }
}

// What the world says about the tile afterwards, not what this tab hoped:
// publish_tile is a compare-and-swap, and losing it is a thing to be told.
//
// And when it did not publish, why — "done as far as this tab can take it" is
// true of every one of these and tells nobody which one it is, so the same
// tile sat in the queue saying the same unhelpful sentence.
async function landed(tile, entry, rows, caps) {
    const [row] = await api.select('tile',
        { z: `eq.${entry.z}`, x: `eq.${entry.x}`, y: `eq.${entry.y}`,
            select: 'published_version' }).catch(() => []);
    if (Number(row?.published_version ?? 0) >= Number(entry.version)) {
        const more = drawnWhen(entry);
        return `${tile} is published${more ? ` \u2014 ${more}` : ''}`;
    }
    const now = (rows ?? []).find((r) => r.job === entry.job);
    if (!now) {
        return `${tile}: every piece is done and the publish did not land —`
            + ' the world moved on while this tab was working. Submit it again.';
    }
    if (Number(now.claimed) > 0 && !Number(now.ready)) {
        return `${tile}: ${now.claimed} piece(s) are in somebody else's hands.`;
    }
    if (!Number(now.ready)) {
        return `${tile}: nothing left that anybody can take — ${now.failed || 0}`
            + ' gave up, and the rest are waiting on it. Try again puts it back.';
    }
    if (beyond(now, caps)) {
        return `${tile}: ${now.ready} piece(s) left, and they want more of a GPU`
            + ' than this tab has. Another machine can take them.';
    }
    return `${tile}: ${now.ready} piece(s) left — press Render again.`;
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
        phaseTabs(state.page, state.phase, acts.look),
        pager(state.page, PAGE, acts.turn));
    ui.list.replaceChildren(
        ...state.rows.map((r) => poolCard(r, acts, state.caps)));
    if (!state.rows.length) ui.list.append(...nothingWaiting(state.held));
}
