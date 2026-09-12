// pool.js — Submit, and the pool anybody renders from.
//
// TASKS-usable T6. Two panels, one idea: what you built has to be compiled
// before anyone else can see it, and compiling is somebody's browser doing the
// work. You attach a price and the work becomes public; a stranger takes it,
// runs it in their tab, and is paid when the tile lands.
//
// Neither panel decides anything. submit_area opens the jobs, render_pool says
// what is waiting, claim_for hands out the work, and the escrow pays out on
// publish — all in db/0043_pool.sql and the migrations under it.

import * as api from './api.js';
import { myAccount } from './wallet.js';
import { cr, el, poolReference, priceRow, progressTiles, totalLine } from './poolui.js';
export { mountPool } from './renderpool.js';

// ------------------------------------------------------------------ submit

export function mountSubmit(host, { onSubmitted = () => {}, onCount = () => {} } = {}) {
    const ui = submitParts();
    const state = { areas: [], progress: null, pool: [], balance: 0 };
    const say = (msg, bad = false) => {
        ui.status.textContent = msg;
        ui.status.dataset.bad = bad ? '1' : '';
    };
    layoutSubmit(host, ui);

    const chosenArea = () => state.areas.find((a) => a.id === ui.area.value);

    const draw = () => drawSubmit(ui, state, draw);

    async function progress() {
        const chosen = chosenArea();
        state.progress = chosen
            ? await api.rpc('area_progress', { area_id: chosen.id }).catch(() => null)
            : null;
        if (state.progress) onCount(state.progress);
        draw();
    }

    async function refresh() {
        state.areas = (await api.rpc('my_areas').catch(() => []))
            .filter((a) => a.may_write);
        ui.area.replaceChildren(...state.areas.map(
            (a) => new Option(a.rules?.name || 'unnamed land', a.id)));
        say(state.areas.length ? '' : 'no land of yours to submit');
        state.pool = await api.rpc('render_pool', { limit: 200 }).catch(() => []);
        state.balance = (await myAccount().catch(() => null))?.amount ?? 0;
        await progress();
        return state.areas;
    }

    async function send() {
        const chosen = chosenArea();
        if (!chosen) { say('pick some land first', true); return; }
        ui.send.disabled = true;
        try {
            const out = await api.rpc('submit_area', {
                area_id: chosen.id, price: Number(ui.price.value) || 0,
            });
            say(out.tiles
                ? `${out.tiles} tile(s) in the pool${out.spent ? `, ${cr(out.spent)} held` : ''}`
                : 'nothing on that land has changed since it was last compiled');
            await refresh();
            onSubmitted(out);
        } catch (err) {
            say(String(err.body?.message ?? err.message ?? err), true);
        }
    }

    ui.send.onclick = send;
    ui.mine.onclick = () => { ui.price.value = '0'; draw(); send(); };
    ui.price.oninput = draw;
    ui.area.onchange = progress;
    refresh();
    return { refresh, send, progress };
}

function submitParts() {
    return {
        area: el('select', { className: 'su-area' }),
        tiles: el('div', { className: 'tiles' }),
        price: el('input', {
            className: 'su-price', type: 'number', min: '0', step: '1', value: '0',
        }),
        presets: el('div', { className: 'section' }),
        reference: el('div', { className: 'note' }),
        total: el('div', { className: 'note' }),
        send: el('button', {
            type: 'button', className: 'su-send primary', textContent: 'Submit',
        }),
        mine: el('button', { type: 'button', textContent: 'Render it myself' }),
        status: el('p', { className: 'su-status status' }),
    };
}

// How many tiles a Submit would put in the pool: what has changed and is not
// already there.
function toSubmit(p) {
    return p ? Math.max(0, Number(p.waiting) - Number(p.open_jobs)) : 0;
}

function drawSubmit(ui, state, draw) {
    ui.tiles.replaceChildren(...progressTiles(state.progress));
    ui.presets.replaceChildren(
        el('span', { className: 'label', textContent: 'What to pay for each tile' }),
        el('div', { className: 'row' }, ui.price,
            priceRow(ui.price.value, (v) => { ui.price.value = String(v); draw(); })));
    ui.reference.textContent = poolReference(state.pool);
    const n = toSubmit(state.progress);
    const price = Number(ui.price.value) || 0;
    ui.total.replaceChildren(...totalLine(n, price, state.balance));
    ui.send.textContent = n
        ? `Submit ${n} tile(s)${price > 0 ? ` · ${cr(n * price)} cr` : ''}`
        : 'Nothing to submit';
    ui.send.disabled = !n;
}

function layoutSubmit(host, ui) {
    host.append(
        el('div', { className: 'section' },
            el('span', { className: 'label', textContent: 'Which land' }), ui.area),
        el('div', { className: 'section' },
            el('span', { className: 'label', textContent: 'Tiles on it' }), ui.tiles),
        ui.presets, ui.reference, ui.total,
        el('div', { className: 'row' }, ui.send, ui.mine),
        el('div', { className: 'note',
            textContent: 'At nothing to pay, nobody else has a reason to render'
                + ' it — you can still do it yourself, free, on this machine.' }),
        ui.status);
}

// -------------------------------------------------------------------- pool

