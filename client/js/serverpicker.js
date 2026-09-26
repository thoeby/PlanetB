// serverpicker.js — the Server control in Automate's top bar (TASKS-flows.md
// FL.1, docs/design/flows-servers.md §1).
//
// A dropdown of My collection and the player's process servers, a dot that says whether the
// chosen one is answering, and the two dialogs behind "Add a server…" and
// "Manage servers…". Choosing another server tells whoever is listening at
// once — nothing reloads. The dot is asked every 15 s, and only while
// Automate is open.

import { el } from './poolui.js';
import * as ps from './processservers.js';
import { reach, reachWords } from '../flow/server/client.js';

const POLL_MS = 15_000;
const ADD = '__add', MANAGE = '__manage';
// UI.8: not a server — your own flows, on your land. Chosen, the left column
// lists them; it is where Automate starts.
export const MINE = '__mine';

const field = (label, value = '', cls = '') => {
    const input = el('input', { type: 'text', value, className: cls });
    input.setAttribute('aria-label', label);
    return { input, row: el('label', { className: 'fl-field' },
        el('span', { textContent: label }), input) };
};

// Add a server, or change one: name, address, Test, Save.
function editDialog(host, row, done) {
    const name = field('Server name', row?.name ?? '', 'fl-srv-name');
    const url = field('Server address', row?.url ?? 'http://', 'fl-srv-url');
    const answer = el('p', { className: 'muted fl-srv-answer' });
    const err = el('p', { className: 'fl-err', hidden: true });
    const test = el('button', { type: 'button', textContent: 'Test' });
    const save = el('button', { type: 'button', className: 'primary', textContent: 'Save' });
    const cancel = el('button', { type: 'button', textContent: 'Cancel' });
    const wrap = el('div', { className: 'fl-ask fl-srv-dialog' }, el('div', {},
        el('h3', { textContent: row ? `Change ${row.name}` : 'Add a server' }),
        name.row, url.row, answer, err, el('div', { className: 'fl-acts' }, test, save, cancel)));
    const close = () => wrap.remove();
    test.onclick = async () => {
        answer.textContent = 'asking…';
        answer.dataset.tone = 'quiet';
        const r = await reach(url.input.value.trim());
        answer.textContent = reachWords(r, location.origin);
        answer.dataset.tone = { up: 'good', cors: 'warn' }[r.state] ?? 'bad';
    };
    save.onclick = async () => {
        try {
            await ps.saveServer(row?.id, name.input.value.trim(), url.input.value.trim());
            close();
            await done(name.input.value.trim());
        } catch (e) {
            err.textContent = String(e?.message ?? e).replace(/^\d+ \S+: /, '');
            err.hidden = false;
        }
    };
    cancel.onclick = close;
    host.append(wrap);
    name.input.focus();
}

// Remove, in design 10f's two ways: refused while flows of yours run there,
// asked otherwise.
async function removing(li, s, on) {
    li.querySelector('.fl-srv-say')?.remove();
    const why = await on.removable(s);
    const say = el('div', { className: 'fl-srv-say' });
    if (why) {
        say.append(el('p', { textContent: why }));
        say.dataset.tone = 'warn';
        li.append(say);
        return;
    }
    const yes = el('button', { type: 'button', textContent: 'Remove' });
    const no = el('button', { type: 'button', textContent: 'Cancel' });
    say.append(el('p', { textContent: `Remove ${s.name}? Flows sent there keep running there;`
        + ' this page just stops showing them.' }), yes, no);
    yes.onclick = async () => {
        await ps.removeServer(s.id);
        li.remove();
        await on.changed();
    };
    no.onclick = () => say.remove();
    li.append(say);
}

// Every server of mine, with Edit and Remove. World's server is the
// operator's and is changed in Setup, so it is listed without either.
function manageDialog(host, list, on) {
    const rows = el('ul', { className: 'fl-list fl-srv-list' });
    const done = el('button', { type: 'button', className: 'primary', textContent: 'Done' });
    const wrap = el('div', { className: 'fl-ask fl-srv-dialog' }, el('div', {},
        el('h3', { textContent: 'Your process servers' }), rows,
        el('div', { className: 'fl-acts' }, done)));
    for (const s of list) {
        const dot = el('span', { className: 'fl-dot' });
        reach(s.url).then((r) => { dot.dataset.state = r.state === 'up' ? 'up' : 'down'; });
        const li = el('li', { className: 'fl-srv-row' }, dot,
            el('span', { className: 'pick', textContent: s.name }),
            el('span', { className: 'muted mono', textContent: s.url }));
        li.dataset.server = s.name;
        if (!s.fixed) {
            const edit = el('button', { type: 'button', textContent: 'Edit' });
            edit.onclick = () => { wrap.remove(); on.edit(s); };
            const del = el('button', { type: 'button', textContent: 'Remove' });
            del.onclick = () => removing(li, s, on);
            li.append(edit, del);
        }
        rows.append(li);
    }
    if (!list.length) rows.append(el('li', { className: 'muted', textContent: 'None yet.' }));
    done.onclick = () => wrap.remove();
    host.append(wrap);
}

// The bar's control, design 10a/10d: a box that says SERVER, the dot, the
// name and the version, and opens a list of the servers with their addresses.
// The native select stays, out of sight, for the keyboard and the tests.
function barParts(host) {
    const select = el('select', { className: 'fl-server' });
    select.setAttribute('aria-label', 'Server');
    const dot = el('span', { className: 'fl-dot', title: 'checking' });
    dot.dataset.state = 'checking';
    const name = el('span', { className: 'fl-srv-name' });
    const words = el('span', { className: 'mono fl-version' });
    const open = el('button', { type: 'button', className: 'fl-srv-open',
        title: 'Choose a process server' },
    el('span', { className: 'fl-srv-label', textContent: 'Server' }), dot, name, words,
    el('span', { className: 'fl-caret', textContent: '\u25be' }));
    open.setAttribute('aria-haspopup', 'listbox');
    const tip = el('span', { className: 'fl-srv-tip', hidden: true });
    const menu = el('div', { className: 'fl-srv-menu', hidden: true });
    host.append(open, select, tip, menu);
    return { select, dot, words, name, open, tip, menu };
}

// One row of the open list: the dot, the name and address, and the version or
// "read-only" for the operator's own.
function menuRow(s, state, pick) {
    const dot = el('span', { className: 'fl-dot' });
    const side = el('span', { className: 'mono fl-srv-side',
        textContent: s.fixed ? 'read-only' : '' });
    reach(s.url).then((r) => {
        dot.dataset.state = r.state === 'up' ? 'up' : 'down';
        if (!s.fixed && r.state === 'up') side.textContent = r.version ?? '';
        if (r.state !== 'up') row.title = reachWords(r, location.origin);
    });
    const row = el('button', { type: 'button', className: 'fl-srv-item' }, dot,
        el('span', { className: 'fl-srv-what' }, el('span', { textContent: s.name }),
            el('span', { className: 'mono', textContent: s.url.replace(/^https?:\/\//, '') })),
        side);
    row.dataset.on = state.current?.id === s.id ? '1' : '';
    row.onclick = () => pick(s.id);
    return row;
}

function drawMenu(parts, state, pick) {
    const add = el('button', { type: 'button', className: 'fl-srv-item fl-srv-add',
        textContent: 'Add a server\u2026' });
    add.onclick = () => pick(ADD);
    const manage = el('button', { type: 'button', className: 'fl-srv-item fl-srv-manage',
        textContent: 'Manage servers\u2026' });
    manage.onclick = () => pick(MANAGE);
    const mine = el('button', { type: 'button', className: 'fl-srv-item fl-srv-mine' },
        el('span', { className: 'fl-srv-what' }, el('span', { textContent: 'My collection' }),
            el('span', { className: 'mono', textContent: 'your flows, on your land' })));
    mine.dataset.on = state.current ? '' : '1';
    mine.onclick = () => pick(MINE);
    parts.menu.replaceChildren(mine, el('span', { className: 'fl-srv-sec',
        textContent: 'Servers' }), ...state.list.map((s) => menuRow(s, state, pick)),
    add, manage);
}

// Ask the chosen server whether it is there. Up, the bar shows its version;
// not up, the sentence that says why — where the player is looking, not only
// in a tooltip.
function prober(state, { dot, words, name, tip }) {
    return async () => {
        const s = state.current;
        name.textContent = s?.name ?? 'My collection';
        if (!s) {
            dot.dataset.state = 'none';
            words.textContent = '';
            tip.hidden = true;
            return;
        }
        const r = await reach(s.url);
        if (state.current !== s) return;
        dot.dataset.state = r.state === 'up' ? 'up' : 'down';
        dot.title = reachWords(r, location.origin);
        words.textContent = r.state === 'up' ? r.version ?? '' : '';
        tip.textContent = r.state === 'up' ? '' : dot.title;
        tip.dataset.tone = r.state === 'cors' ? 'warn' : 'bad';
        tip.hidden = r.state === 'up';
    };
}

// The list opens under the control and closes on a choice or a press
// elsewhere; closed, it holds nothing, so its dots are not the bar's.
function dropdown(host, parts, state, choose) {
    const close = () => { parts.menu.hidden = true; parts.menu.replaceChildren(); };
    parts.open.onclick = () => {
        if (!parts.menu.hidden) { close(); return; }
        drawMenu(parts, state, (v) => { close(); choose(v); });
        parts.menu.hidden = false;
    };
    document.addEventListener('pointerdown', (e) => {
        if (!parts.menu.hidden && !host.contains(e.target)) close();
    });
}

export function mountServerPicker(host, dialogs, on = {}) {
    const parts = barParts(host);
    const { select } = parts;
    const state = { list: [], current: null, timer: null, listeners: [] };
    const probe = prober(state, parts);
    const draw = () => {
        select.replaceChildren(el('option', { value: MINE, textContent: 'My collection' }),
            el('optgroup', { label: 'Servers' }, ...state.list.map((s) =>
                el('option', { value: s.id, textContent: s.name }))),
            el('option', { value: ADD, textContent: 'Add a server…' }),
            el('option', { value: MANAGE, textContent: 'Manage servers…' }));
        select.value = state.current?.id ?? MINE;
    };
    const set = (s) => {
        state.current = s;
        ps.choose(s?.id ?? MINE);
        draw();
        probe();
        for (const fn of state.listeners) fn(s);
    };
    async function refresh(wantName = null) {
        state.list = await ps.servers();
        const want = wantName && state.list.find((s) => s.name === wantName);
        const id = state.current?.id ?? ps.chosenId();
        const next = want ?? (id && id !== MINE ? ps.pick(state.list, id) : null);
        if (next?.id !== state.current?.id || next?.url !== state.current?.url) set(next);
        else { state.current = next; draw(); }
    }
    const choose = (v) => {
        if (v === ADD) editDialog(dialogs(), null, refresh);
        else if (v === MANAGE) {
            manageDialog(dialogs(), state.list, {
                edit: (s) => editDialog(dialogs(), s, refresh),
                removable: on.removable ?? (async () => ''),
                changed: () => refresh(),
            });
        } else if (v === MINE) set(null);
        else set(state.list.find((s) => s.id === v) ?? null);
    };
    select.onchange = () => {
        const v = select.value;
        select.value = state.current?.id ?? MINE;
        choose(v);
    };
    dropdown(host, parts, state, choose);
    return {
        current: () => state.current,
        onChange: (fn) => state.listeners.push(fn),
        refresh,
        start() {
            clearInterval(state.timer);
            state.timer = setInterval(probe, POLL_MS);
            return refresh().then(probe);
        },
        stop() { clearInterval(state.timer); state.timer = null; },
    };
}
