// serverpicker.js — the Server control in Automate's top bar (TASKS-flows.md
// FL.1, docs/design/flows-servers.md §1).
//
// A dropdown of the player's process servers, a dot that says whether the
// chosen one is answering, and the two dialogs behind "Add a server…" and
// "Manage servers…". Choosing another server tells whoever is listening at
// once — nothing reloads. The dot is asked every 15 s, and only while
// Automate is open.

import { el } from './poolui.js';
import * as ps from './processservers.js';
import { reach, reachWords } from '../flow/server/client.js';

const POLL_MS = 15_000;
const ADD = '__add', MANAGE = '__manage';

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

// The three things on the bar: the dropdown, the dot, and the words after it.
function barParts(host) {
    const select = el('select', { className: 'fl-server' });
    select.setAttribute('aria-label', 'Server');
    const dot = el('span', { className: 'fl-dot', title: 'checking' });
    dot.dataset.state = 'checking';
    const words = el('span', { className: 'muted mono fl-version' });
    host.append(el('span', { className: 'muted', textContent: 'Server' }), select, dot, words);
    return { select, dot, words };
}

// Ask the chosen server whether it is there. Up, the bar shows its version;
// not up, the sentence that says why — where the player is looking, not only
// in a tooltip.
function prober(state, { dot, words }) {
    return async () => {
        const s = state.current;
        if (!s) {
            dot.dataset.state = 'none';
            words.textContent = '';
            return;
        }
        const r = await reach(s.url);
        if (state.current !== s) return;
        dot.dataset.state = r.state === 'up' ? 'up' : 'down';
        dot.title = reachWords(r, location.origin);
        words.textContent = r.state === 'up' ? r.version ?? '' : dot.title;
        words.dataset.tone = { up: 'quiet', cors: 'warn' }[r.state] ?? 'bad';
    };
}

export function mountServerPicker(host, dialogs, on = {}) {
    const parts = barParts(host);
    const { select } = parts;
    const state = { list: [], current: null, timer: null, listeners: [] };
    const probe = prober(state, parts);
    const draw = () => {
        select.replaceChildren(...state.list.map((s) =>
            el('option', { value: s.id, textContent: s.name })),
        el('option', { value: ADD, textContent: 'Add a server…' }),
        el('option', { value: MANAGE, textContent: 'Manage servers…' }));
        select.value = state.current?.id ?? ADD;
    };
    const set = (s) => {
        state.current = s;
        ps.choose(s?.id ?? null);
        draw();
        probe();
        for (const fn of state.listeners) fn(s);
    };
    async function refresh(wantName = null) {
        state.list = await ps.servers();
        const want = wantName && state.list.find((s) => s.name === wantName);
        const next = want ?? ps.pick(state.list, state.current?.id ?? ps.chosenId());
        if (next?.id !== state.current?.id || next?.url !== state.current?.url) set(next);
        else { state.current = next; draw(); }
    }
    select.onchange = () => {
        const v = select.value;
        select.value = state.current?.id ?? ADD;
        if (v === ADD) editDialog(dialogs(), null, refresh);
        else if (v === MANAGE) {
            manageDialog(dialogs(), state.list, {
                edit: (s) => editDialog(dialogs(), s, refresh),
                removable: on.removable ?? (async () => ''),
                changed: () => refresh(),
            });
        } else set(state.list.find((s) => s.id === v) ?? null);
    };
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
