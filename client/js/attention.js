// attention.js — the chip that says how many things are waiting for you.
//
// SPEC §2.1: a count of things waiting for *you*, click for the list; §2.15:
// every notification has one action that goes to the thing. The rows come from
// my_notifications (db/0063_landrequests.sql) and carry their own words, so
// nothing here decides what is worth telling anybody.

import * as api from './api.js';

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

const EVERY_MS = 5000;

export function mountAttention(host, { onGo = () => {}, openPanel = () => {},
    onChange = () => {} } = {}) {
    const count = el('span', { className: 'count', textContent: '0' });
    const chip = el('button', { id: 'attention', type: 'button', className: 'glass' },
        el('span', { className: 'label', textContent: 'Waiting' }), count);
    const list = el('div', { id: 'attention-list', className: 'glass' });
    list.hidden = true;
    chip.onclick = () => { list.hidden = !list.hidden; };
    host.append(chip, list);

    let rows = [];

    function draw() {
        count.textContent = String(rows.length);
        chip.dataset.waiting = rows.length ? '1' : '';
        if (!rows.length) {
            list.replaceChildren(el('p', { className: 'muted',
                textContent: 'Nothing is waiting for you.' }));
            return;
        }
        list.replaceChildren(...rows.map((n) => {
            const row = el('button', { type: 'button', className: 'bare' },
                el('span', { className: 'words', textContent: n.words }));
            row.onclick = () => act(n);
            return row;
        }));
    }

    // One action, and it goes to the thing: the panel it happened in, and the
    // place in the world if it has one.
    async function act(n) {
        await api.rpc('mark_seen', { n_id: n.id }).catch(() => {});
        if (n.goes_to?.panel) openPanel(n.goes_to.panel);
        if (n.goes_to?.lon !== undefined) {
            onGo({ lon: n.goes_to.lon, lat: n.goes_to.lat });
        }
        await refresh();
    }

    async function refresh() {
        const before = rows.map((n) => n.id).join(',');
        rows = api.userId()
            ? await api.rpc('my_notifications', { only_waiting: true }).catch(() => [])
            : [];
        draw();
        // Something new waiting is also something new to look at: the panels
        // that show it refresh without anybody reloading the page.
        if (rows.map((n) => n.id).join(',') !== before) onChange(rows);
        return rows;
    }

    draw();
    refresh();
    const timer = setInterval(refresh, EVERY_MS);
    return { refresh, rows: () => rows, stop: () => clearInterval(timer) };
}
