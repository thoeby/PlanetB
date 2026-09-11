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

const SUBMIT_HTML = `
<label>Which land</label>
<select class="su-area"></select>
<label>What to pay for each tile</label>
<div class="row">
  <input class="su-price" type="number" min="0" step="1" value="0">
  <button type="button" class="su-send primary">Submit</button>
</div>
<p class="su-note muted">Nothing to pay means nobody else has a reason to render
  it — you can do it yourself from the Render pool.</p>
<ul class="su-progress"></ul>
<p class="su-status status"></p>`;

const POOL_HTML = `
<div class="row">
  <button type="button" class="po-refresh">Refresh</button>
</div>
<ul class="po-list"></ul>
<p class="po-status status"></p>`;

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
    return node;
};

const far = (metres) => (metres === null || metres === undefined ? ''
    : metres < 1000 ? `${Math.round(metres)} m away`
        : `${(metres / 1000).toFixed(1)} km away`);

// ------------------------------------------------------------------ submit

export function mountSubmit(host, { onSubmitted = () => {}, onCount = () => {} } = {}) {
    const box = el('div');
    box.innerHTML = SUBMIT_HTML;
    host.append(box);
    const q = (sel) => box.querySelector(sel);
    const say = (msg, bad = false) => {
        q('.su-status').textContent = msg;
        q('.su-status').dataset.bad = bad ? '1' : '';
    };
    let areas = [];

    async function progress() {
        const chosen = areas.find((a) => a.id === q('.su-area').value);
        if (!chosen) { q('.su-progress').replaceChildren(); return; }
        const p = await api.rpc('area_progress', { area_id: chosen.id }).catch(() => null);
        if (!p) return;
        q('.su-progress').replaceChildren(
            el('li', {}, `${p.published} of ${p.tiles} tile(s) compiled`),
            el('li', {}, `${p.waiting} waiting`),
            el('li', {}, `${p.open_jobs} in the pool, ${p.in_escrow} held`
                + ' for whoever renders them'));
        onCount(Math.max(0, p.waiting - p.open_jobs));
    }

    async function refresh() {
        areas = (await api.rpc('my_areas').catch(() => []))
            .filter((a) => a.may_write);
        q('.su-area').replaceChildren(...areas.map(
            (a) => new Option(a.rules?.name || 'unnamed land', a.id)));
        if (!areas.length) say('no land of yours to submit');
        await progress();
        return areas;
    }

    async function send() {
        const chosen = areas.find((a) => a.id === q('.su-area').value);
        if (!chosen) { say('pick some land first', true); return; }
        q('.su-send').disabled = true;
        try {
            const out = await api.rpc('submit_area', {
                area_id: chosen.id, price: Number(q('.su-price').value) || 0,
            });
            say(out.tiles
                ? `${out.tiles} tile(s) in the pool${out.spent ? `, ${out.spent} held` : ''}`
                : 'nothing on that land has changed since it was last compiled');
            await progress();
            onSubmitted(out);
        } catch (err) {
            say(String(err.body?.message ?? err.message ?? err), true);
        } finally {
            q('.su-send').disabled = false;
        }
    }

    q('.su-send').onclick = send;
    q('.su-area').onchange = progress;
    refresh();
    return { refresh, send, progress };
}

// -------------------------------------------------------------------- pool

function poolRow(entry, onRender) {
    const render = el('button', { type: 'button', className: 'po-render',
        textContent: entry.bounty > 0 ? `Render for ${entry.bounty}` : 'Render' });
    render.onclick = () => onRender(entry, render);
    return el('li', { className: 'po-entry' },
        el('div', {}, el('b', { textContent: `${entry.z}/${entry.x}/${entry.y}` }),
            el('span', { className: 'muted', textContent: ` ${far(entry.metres)}` })),
        el('div', { className: 'muted',
            textContent: `${entry.ready} piece(s) to do`
                + (entry.claimed ? `, ${entry.claimed} in hand` : '') }),
        render);
}

export function mountPool(host, { loop, where = () => ({}) } = {}) {
    const box = el('div');
    box.innerHTML = POOL_HTML;
    host.append(box);
    const q = (sel) => box.querySelector(sel);
    const say = (msg, bad = false) => {
        q('.po-status').textContent = msg;
        q('.po-status').dataset.bad = bad ? '1' : '';
    };

    async function render(entry, button) {
        const work = await loop();
        if (!work) { say('nothing here can render', true); return; }
        if (!api.token()) { say('sign in first — the work is paid for', true); return; }
        button.disabled = true;
        say(`rendering ${entry.z}/${entry.x}/${entry.y}…`);
        work.focus(entry.job);
        try {
            let state = await work.step();
            while (state) state = await work.step();
            say(`${entry.z}/${entry.x}/${entry.y} is done as far as this tab can take it`);
        } catch (err) {
            say(String(err.message ?? err), true);
        } finally {
            work.focus(null);
            button.disabled = false;
            await refresh();
        }
    }

    async function refresh() {
        const { lon, lat } = where() ?? {};
        const rows = await api.rpc('render_pool',
            { lon: lon ?? null, lat: lat ?? null, limit: 40 }).catch(() => []);
        q('.po-list').replaceChildren(...rows.map((r) => poolRow(r, render)));
        if (!rows.length) {
            q('.po-list').append(el('li', { className: 'muted',
                textContent: 'nothing waiting: every tile anybody submitted is compiled' }));
        }
        say(rows.length ? `${rows.length} waiting` : '');
        return rows;
    }

    q('.po-refresh').onclick = refresh;

    refresh();
    return { refresh, render };
}
