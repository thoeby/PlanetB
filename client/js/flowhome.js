// flowhome.js — Automate › Flows, the page Automate opens on (TASKS-ui.md UI.8).
//
// Every flow on land you build on, as cards under the land it belongs to: what
// it is on, where it runs, and the two things to do with it — open it in the
// Editor, or run it on a server of yours. Beside them, what Automate is for,
// in three lines, for somebody who has never drawn a flow.

import { el } from './poolui.js';
import { empty } from './empty.js';

const HOW = [
    ['Draw', 'In the Editor: blocks from the palette, wired together. A flow is kept on'
        + ' its land, for everybody who builds there.'],
    ['Run', 'On a process server of yours — choose one in Server, then Send or Run on…'],
    ['Schedule', 'Jobs start a process at set times; the Schedule shows them on a'
        + ' timeline. Paths put a product on a route over your land.'],
];

function card(row, state, on) {
    const thing = row.instance_id && state.things.get(row.instance_id)?.name;
    const run = state.runs.get(row.id);
    const open = el('button', { type: 'button', className: 'primary fh-open',
        textContent: 'Open' });
    open.onclick = () => on.open(row);
    const runOn = el('button', { type: 'button', className: 'fh-run',
        textContent: run ? `Update on ${run.server}` : 'Run on…' });
    runOn.onclick = () => on.run(row);
    const where = el('span', { className: 'fh-run-state' });
    where.textContent = run
        ? `● runs on ${run.server}${run.changed ? ' · changed since sent' : ''}`
        : 'not running anywhere';
    where.dataset.tone = run ? (run.changed ? 'warn' : 'good') : 'quiet';
    const li = el('li', { className: 'fh-card' },
        el('b', { className: 'fh-name', textContent: row.name }),
        el('span', { className: 'muted', textContent: thing ? `on ${thing}` : 'on the land' }),
        where,
        el('div', { className: 'fh-acts' }, open, runOn));
    li.dataset.flow = row.id;
    li.dataset.on = row.id === state.openId ? '1' : '';
    return li;
}

function drawLands(host, state, on) {
    const byLand = new Map();
    for (const r of state.rows) {
        if (!byLand.has(r.area_id)) byLand.set(r.area_id, []);
        byLand.get(r.area_id).push(r);
    }
    host.replaceChildren(...state.lands.filter((a) => byLand.has(a.id)).map((a) =>
        el('section', { className: 'fh-land' },
            el('h3', { textContent: `${a.name || 'unnamed land'} · ${byLand.get(a.id).length}` }),
            el('ul', { className: 'fh-cards' },
                ...byLand.get(a.id).map((r) => card(r, state, on))))));
    if (!state.rows.length) {
        host.append(state.lands.length
            ? empty('No flows yet', 'A flow is a set of blocks that makes something on your'
                + ' land happen — a lamp at dusk, a door that opens.',
            { act: 'New flow', onAct: on.create })
            : empty('Nowhere to put a flow', 'A flow lives on land you build on. Get land'
                + ' first, in Build › Your land.'));
    }
}

export function mountHome(host, on) {
    const count = el('span', { className: 'muted fh-count' });
    const create = el('button', { type: 'button', className: 'primary fh-new',
        textContent: 'New flow' });
    create.onclick = on.create;
    const lands = el('div', { className: 'fh-lands' });
    host.append(
        el('div', { className: 'fh-main' },
            el('div', { className: 'fh-head' }, el('h2', { textContent: 'Your flows' }), count,
                el('span', { className: 'spacer' }), create),
            lands),
        el('aside', { className: 'fh-how' },
            el('h3', { textContent: 'How it works' }),
            el('ol', {}, ...HOW.map(([h, t]) => el('li', {}, el('b', { textContent: h }),
                el('span', { textContent: t }))))));
    const state = { rows: [], lands: [], openId: null, things: new Map(), runs: new Map() };
    return {
        node: host,
        set(rows, landsNow, openId, things = new Map(), runs = new Map()) {
            Object.assign(state, { rows: rows ?? [], lands: landsNow ?? [], openId,
                things, runs });
            count.textContent = `${state.rows.length} flow${state.rows.length === 1 ? '' : 's'}`
                + ` · ${runs.size} running`;
            create.disabled = !state.lands.length;
            drawLands(lands, state, on);
        },
    };
}
