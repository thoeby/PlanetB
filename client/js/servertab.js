// servertab.js — the left column's second tab, "On <server>" (TASKS-flows.md
// FL.3–FL.5, docs/design/flows-servers.md §3).
//
// What is on the chosen process server, in sections: its processes, its
// services, its jobs and its reports. Nothing listed here is kept in the world;
// every list is asked for again when the server changes or Refresh is pressed.
// Each section is a module of its own and is handed the same small bag: the
// server, a way to say something, and the dialog host.

import { el } from './poolui.js';

// The two tabs over the left column: My flows, and On <server>.
export function leftTabs(host) {
    const mine = el('button', { type: 'button', className: 'fl-tab', textContent: 'My flows' });
    const word = el('span', { textContent: 'On a server' });
    const dot = el('i', { className: 'fl-tabdot' });
    const remote = el('button', { type: 'button', className: 'fl-tab' }, word, dot);
    for (const b of [mine, remote]) b.setAttribute('role', 'tab');
    const bar = el('div', { className: 'fl-tabs', role: 'tablist' }, mine, remote);
    const minePane = el('div', { className: 'fl-pane' });
    const remotePane = el('div', { className: 'fl-pane' });
    host.append(bar, minePane, remotePane);
    const show = (which) => {
        mine.setAttribute('aria-selected', String(which === 'mine'));
        remote.setAttribute('aria-selected', String(which === 'remote'));
        minePane.hidden = which !== 'mine';
        remotePane.hidden = which !== 'remote';
    };
    mine.onclick = () => show('mine');
    remote.onclick = () => show('remote');
    show('mine');
    return {
        minePane, remotePane, show, dot,
        // The tab is named for the server, and cannot be opened without one.
        server(s) {
            word.textContent = s ? `On ${s.name}` : 'On a server';
            remote.disabled = !s;
            remote.title = s ? '' : 'Choose a server first';
            if (!s && !remotePane.hidden) show('mine');
        },
    };
}

// One collapsible section with a heading, a Refresh, a line for what went
// wrong, and the rows. `draw(list)` fills the rows; `load()` is what Refresh
// and a change of server do.
export function section(host, title, { load, draw, head = [] }) {
    const rows = el('ul', { className: 'fl-list fl-remote-list' });
    const err = el('p', { className: 'fl-err', hidden: true });
    const again = el('button', { type: 'button', className: 'fl-again', textContent: 'Refresh' });
    const count = el('small', { className: 'fl-count' });
    // Design 10b: the heading, its count, and the section's actions on one line.
    const summary = el('summary', {}, el('span', { className: 'fl-caret', textContent: '\u25be' }),
        el('span', { className: 'fl-sec-title', textContent: title }), count,
        el('span', { className: 'fl-acts fl-sec-acts' }, ...head, again));
    // A press on an action is the action's, not the heading's.
    summary.addEventListener('click', (e) => {
        if (e.target.closest('button, select')) e.preventDefault();
    });
    const details = el('details', { className: 'fl-section', open: true }, summary, err, rows);
    host.append(details);
    const run = async () => {
        err.hidden = true;
        try {
            const list = await load();
            rows.replaceChildren();
            count.textContent = Array.isArray(list) ? String(list.length) : '';
            draw(rows, list);
        } catch (e) {
            rows.replaceChildren();
            err.textContent = String(e?.message ?? e);
            err.hidden = false;
        }
    };
    again.onclick = run;
    return { node: details, rows, err, run };
}

// A button in a row.
export const act = (text, cls, onclick) => {
    const b = el('button', { type: 'button', className: cls, textContent: text });
    b.onclick = onclick;
    return b;
};

// The sentence for a failed call, without the transport's own prefix.
export const plain = (e) => String(e?.message ?? e).replace(/^\d+ \S+: /, '');
