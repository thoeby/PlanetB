// servertab.js — the left column when a server is chosen, "On <server>"
// (TASKS-flows.md FL.3–FL.5, docs/design/flows-servers.md §3).
//
// What is on the chosen process server, in sections: its processes, its
// services, its jobs and its reports. Nothing listed here is kept in the world;
// every list is asked for again when the server changes or Refresh is pressed.
// Each section is a module of its own and is handed the same small bag: the
// server, a way to say something, and the dialog host.

import { el } from './poolui.js';

// The left column holds one of two things, and the Server control decides
// which (TASKS-ui.md UI.8): with My collection chosen, your flows; with a
// server chosen, what is on it.
export function leftPanes(host) {
    const head = el('div', { className: 'fl-pane-head' });
    const minePane = el('div', { className: 'fl-pane fl-mine' });
    const remotePane = el('div', { className: 'fl-pane fl-on-server' });
    host.append(head, minePane, remotePane);
    const server = (s) => {
        head.textContent = s ? `On ${s.name}` : 'My collection';
        minePane.hidden = Boolean(s);
        remotePane.hidden = !s;
    };
    server(null);
    return { minePane, remotePane, server };
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
