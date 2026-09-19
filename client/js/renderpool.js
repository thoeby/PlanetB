// renderpool.js — the Work queues (design 8a–8d): every tile waiting to be
// compiled, drawn as a card each, in a tab per kind of work — All, Render
// jobs, Training and Publish, which are the phases the pool itself sorts into
// (db/0152 pool_open.phase). A card opens into client/js/jobdetail.js.
//
// claim_for hands out the work and the escrow pays on publish
// (db/0043_pool.sql); this panel decides nothing. Only the queue the player is
// looking at is drawn, and only it is asked for: a page of one kind of work is
// one request, and four tabs of the same cards would be four.

import * as api from './api.js';
import { DOING, beyond, drawnWhen, el, what } from './poolui.js';
import { pager, poolCard, showChips, sortChips } from './poolcard.js';
import { jobDetail } from './jobdetail.js';
import { empty } from './empty.js';

const said = (err) => String(err?.body?.message ?? err?.message ?? err);

// Cards on a page. Enough to scroll through, few enough that the page after
// this one is a press away rather than a scroll to the bottom of everything.
const PAGE = 24;

// Which phase of the pool each tab of Work shows, and the sentence under it.
export const QUEUES = {
    'Every job': { phase: 'all',
        foot: 'Payouts are what the owner put in the pool. “free” means nobody'
            + ' pays — you can still draw it.' },
    'Render jobs': { phase: 'render',
        foot: 'The ground and the frames: what a tile is drawn from, and the'
            + ' long part of drawing it.' },
    Training: { phase: 'train',
        foot: 'Training is minutes of a GPU. A piece a tab gives up on goes'
            + ' back into the pool with the reason on it.' },
    Publishing: { phase: 'publish',
        foot: 'Packing a trained tile and merging the one above it: the cheap'
            + ' end, and what puts a tile on screen.' },
};

// One tab: the chips over the cards, the cards, and the line under them.
function queueParts(name) {
    const ui = {
        chips: el('div', { className: 'jc-chiprow' }),
        list: el('ul', { className: 'rows po-list po-grid' }),
        foot: el('div', { className: 'jc-footline' },
            el('span', { className: 'note', textContent: QUEUES[name].foot })),
        detail: el('div', { className: 'jd-host' }),
    };
    ui.detail.hidden = true;
    ui.node = el('div', { className: 'wk-queue' }, ui.chips, ui.list, ui.foot, ui.detail);
    return ui;
}

// A card opened (design 8f). It takes the tab over rather than opening a
// window of its own: the cards behind it are the list it moves through.
function drawDetail(state, ctx, parts) {
    const e = state.rows.find((r) => r.job === state.open);
    parts.detail.hidden = !e;
    parts.list.hidden = Boolean(e);
    parts.chips.hidden = Boolean(e);
    parts.foot.hidden = Boolean(e);
    if (!e) { parts.detail.replaceChildren(); return; }
    parts.detail.replaceChildren(jobDetail(e, {
        rows: state.rows, atoms: state.atoms, acts: ctx.acts, caps: state.caps,
        onGo: ctx.onGo, close: ctx.acts.close, where: ctx.where,
        ground: ctx.ground(), say: ctx.say, refresh: ctx.refresh,
        doing: ctx.doing(e),
    }));
}

// The chips over the cards: whose work (the All tab only), in what order, and
// which page. The counts are the whole pool's, not the page's.
function drawChips(state, ctx, parts) {
    const first = state.name === 'Every job'
        ? [showChips(state.page, state.phase, ctx.acts.who)] : [];
    parts.chips.replaceChildren(...first,
        sortChips(state.page, ctx.acts.by),
        pager(state.page, PAGE, ctx.acts.turn));
}

// What may be done to a job, in one place: the card and the opened card offer
// the same, and both ask the same RPC.
function actionsOf(state, { loop, say, refresh, draw, ask }) {
    return {
        render: (entry, button) => runJob(entry, button, { loop, say, refresh }),
        retry: (entry, button) => ask(entry, button, 'retry_job',
            (n) => (n ? `${n} piece(s) start over` : 'nothing to try again')),
        drop: (entry, button) => ask(entry, button, 'drop_job',
            (gone) => (gone ? 'dropped from the pool' : 'nothing to drop')),
        // The frames are what a tile was trained on, so a tile trained against
        // the wrong ones is put right by asking for them again (db/0147). The
        // training goes back to waiting; nothing is unmade.
        redo: (entry, button) => ask(entry, button, 'redo_renders',
            (n) => (n ? `${n} frame(s) will be drawn again, and the training after them`
                : 'this tile has no frames of its own')),
        open: (entry) => { state.open = entry.job; return openPieces(state, draw); },
        close: () => { state.open = null; state.atoms = []; draw(); },
        who: (phase) => { state.phase = phase; state.offset = 0; refresh(); },
        turn: (offset) => { state.offset = offset; refresh(); },
        by: (sort) => { state.sort = sort; state.offset = 0; refresh(); },
    };
}

// The pieces of the one job that is open: public, and asked for only when a
// card is opened rather than for every card on the page (db/0003_rls).
async function openPieces(state, redraw) {
    state.atoms = await api.select('atom',
        { job_id: `eq.${state.open}`, order: 'id',
            select: 'id,op,state,attempts,claimed_at' }).catch(() => []);
    redraw();
}

// The tab the player has open, drawn: its chips, its cards, and the card that
// is open over them. The other tabs are left empty until they are asked for.
function drawQueue(state, ui, ctx, count, say) {
    try {
        const parts = ui.get(state.name);
        drawChips(state, ctx, parts);
        parts.list.replaceChildren(...state.rows.map((r) => poolCard(r, ctx.acts,
            state.caps, state.shots?.get(`${r.z}/${r.x}/${r.y}`) ?? null,
            ctx.doing(r))));
        if (!state.rows.length) parts.list.append(...nothingWaiting(state));
        drawDetail(state, ctx, parts);
        for (const [name, q] of Object.entries(QUEUES)) {
            count(name, Number(state.page?.[q.phase] ?? 0));
        }
    } catch (err) {
        say(`the pool could not be drawn: ${said(err)}`, true);
        console.error(err);
    }
}

// What this machine is doing, on the card of the job it is doing it to. The
// grid is redrawn only when the job changes hands; a line every step would
// rebuild the page under somebody's hand.
function tick(state, ui, draw) {
    const live = state.work?.atom?.job_id ?? null;
    if (live !== state.shownLive) { state.shownLive = live; draw(); return; }
    const doing = DOING[state.work?.atom?.op] ?? 'working';
    for (const parts of ui.values()) {
        const at = parts.list.querySelector('li[data-live="1"] .jc-status');
        if (at) at.textContent = `${doing} on this machine`;
    }
}

// A pool that cannot be read says so in its own line; an empty list is the
// answer "nothing is waiting", never the answer "the question failed".
async function readPool(state, { where, loop, say, draw }) {
    const { lon, lat } = where() ?? {};
    state.page = await api.rpc('pool_page',
        { lon: lon ?? null, lat: lat ?? null,
            phase: state.phase === 'all' ? null : state.phase,
            limit: PAGE, offset: state.offset, sort: state.sort })
        .catch((err) => { say(`could not read the pool: ${said(err)}`, true); return null; });
    state.rows = state.page?.rows ?? [];
    // A page past the end of a list that shrank while it was being looked at
    // is an empty panel with tiles behind it; step back to the last one.
    if (!state.rows.length && state.offset > 0) {
        state.offset = Math.max(0, Math.floor(
            (Number(state.page?.total ?? 1) - 1) / PAGE) * PAGE);
        return readPool(state, { where, loop, say, draw });
    }
    state.held = state.rows.length
        ? [] : await api.rpc('pool_held_back', { limit_: 12 }).catch(() => []);
    // What this machine is, asked once and only when the panel is open:
    // probing the adapter is the slowest part of mounting anything.
    state.work ??= await loop?.().catch(() => null) ?? null;
    state.caps ??= state.work?.caps ?? null;
    state.shots = state.work?.pictures ?? null;
    // A job that has left the pool cannot stay open over an empty page.
    if (state.open && !state.rows.some((r) => r.job === state.open)) state.open = null;
    draw();
    return state.rows;
}

// Design 8f: the arrows move through the jobs and Escape goes back to the
// cards. On the way down, because the page's own Escape closes the panel and
// the card behind this one is the nearer thing to close.
function moveWithKeys(state, ui, acts) {
    document.addEventListener('keydown', (event) => {
        const parts = ui.get(state.name);
        if (!parts || parts.detail.hidden || !parts.detail.offsetParent) return;
        if (event.target?.closest?.('input, select, textarea')) return;
        const step = { ArrowDown: 1, ArrowUp: -1 }[event.key] ?? 0;
        if (!step && event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (!step) { acts.close(); return; }
        const at = state.rows.findIndex((r) => r.job === state.open);
        const next = state.rows[Math.min(Math.max(at + step, 0), state.rows.length - 1)];
        if (next) acts.open(next);
    }, true);
}

export function mountPool(hosts, { loop, where = () => ({}), onGo, count = () => {},
    statusHost = null, ground = () => null } = {}) {
    const ui = new Map();
    for (const [name, host] of Object.entries(hosts)) {
        const parts = queueParts(name);
        host.append(parts.node);
        ui.set(name, parts);
    }
    const status = el('p', { className: 'po-status status' });
    (statusHost ?? Object.values(hosts)[0]).append(status);
    // A page of one kind of work at a time (db/0146 pool_page). `page` is
    // what the server answered: its rows, how many there are of this kind,
    // and how many of each kind there are altogether. `name` is the tab the
    // player has open, which is the only one drawn.
    const state = { name: Object.keys(hosts)[0], page: null, rows: [], held: [],
        phase: 'all', sort: 'near', offset: 0, caps: null, shots: null,
        open: null, atoms: [], work: null };
    const say = (msg, bad = false) => {
        status.textContent = msg;
        status.dataset.bad = bad ? '1' : '';
    };

    const ctx = { where, onGo, say, ground,
        // What this tab is doing to this job, if it is doing anything to it.
        doing: (e) => (state.work?.atom?.job_id === e.job
            ? DOING[state.work.atom.op] ?? state.work.atom.op : '') };

    const draw = () => drawQueue(state, ui, ctx, count, say);

    // Which tab, which kind of work, which page, in what order. Each of them
    // resets the page: a page number means nothing across two lists.
    const look = (name) => {
        if (!ui.has(name)) return null;
        for (const [other, parts] of ui) {
            if (other !== name) parts.list.replaceChildren();
        }
        const same = name === state.name;
        state.name = name;
        state.phase = QUEUES[name].phase;
        if (!same) { state.offset = 0; state.open = null; }
        return refresh();
    };

    const ask = async (entry, button, fn, saidIt) => {
        button.disabled = true;
        try {
            const r = await api.rpc(fn, { job_id: entry.job });
            say(`${entry.z}/${entry.x}/${entry.y}: ${saidIt(r)}`);
        } catch (err) {
            say(said(err), true);
        }
        await refresh();
    };
    function refresh() { return readPool(state, { where, loop, say, draw }); }
    const acts = actionsOf(state, { loop, say, refresh, draw, ask });
    ctx.acts = acts;
    ctx.refresh = () => refresh();

    moveWithKeys(state, ui, acts);
    refresh();
    const note = () => tick(state, ui, draw);
    return { refresh, draw, say, look, note,
        render: acts.render, retry: acts.retry, drop: acts.drop, redo: acts.redo };
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

// An empty pool with jobs behind it is the thing that reads as "my approval
// did nothing". Each one says which of the three reasons it is.
function nothingWaiting({ held }) {
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
