// runlog.js — a run's log as the table design 10b draws under the canvas:
// time, level, where, what, with All / Info / Warn / Error over it.
//
// The report's shape is not documented (docs/flow.md, the assumptions table),
// so this reads what is there: every child of a <log>, its level and time from
// attributes when it has them, and "where: what" from its text when not.

import { el } from './poolui.js';

const LEVELS = ['all', 'info', 'warn', 'error'];

function entries(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const out = [];
    for (const log of doc.getElementsByTagName('log')) {
        for (const e of log.children) {
            const text = (e.textContent ?? '').trim();
            const m = /^([^:]{1,40}):\s*(.*)$/.exec(text);
            const level = (e.getAttribute('level') ?? (LEVELS.includes(e.localName)
                ? e.localName : 'info')).toLowerCase().replace('warning', 'warn');
            out.push({ level, time: e.getAttribute('time') ?? e.getAttribute('timestamp') ?? '',
                where: e.getAttribute('source') ?? e.getAttribute('node') ?? (m ? m[1] : ''),
                what: m && !e.getAttribute('source') ? m[2] : text });
        }
    }
    return out;
}

export function runLog() {
    const rows = el('tbody');
    const table = el('table', { className: 'fl-log' }, rows);
    let all = [];
    let shown = 'all';
    const draw = () => {
        const list = all.filter((e) => shown === 'all' || e.level === shown);
        rows.replaceChildren(...list.map((e) => {
            const tr = el('tr', {}, el('td', { textContent: e.time }),
                el('td', { textContent: e.level }), el('td', { textContent: e.where }),
                el('td', { textContent: e.what }));
            tr.dataset.level = e.level;
            return tr;
        }));
        table.hidden = !list.length;
    };
    const buttons = LEVELS.map((l) => {
        const b = el('button', { type: 'button', textContent: l });
        b.onclick = () => { shown = l; mark(); draw(); };
        return b;
    });
    const mark = () => buttons.forEach((b, i) =>
        b.setAttribute('aria-pressed', String(LEVELS[i] === shown)));
    mark();
    return {
        filter: el('div', { className: 'fl-seg fl-log-filter' }, ...buttons),
        table,
        set(xml) { all = xml ? entries(xml) : []; draw(); },
    };
}
