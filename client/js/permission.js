// permission.js — a rendered tile waits for a person.
//
// TASKS-usable T7: what a stranger's browser produced lands on the tile as a
// candidate. Its owner — or whoever they granted `approve` to — looks at it
// where it is, with the switch below, and then publishes it or refuses it with
// a note. Nobody else sees it in the meantime.
//
// The switch is the whole viewer half: streamer.candidates flips which sha a
// loaded tile asks for (client/js/traverse.js showing()), so the same walk
// through the same world shows the waiting version in place.

import * as api from './api.js';

const HTML = `
<label><input type="checkbox" class="pm-show"> Show what is waiting, in place</label>
<div class="row">
  <button type="button" class="pm-refresh">Refresh</button>
</div>
<ul class="pm-list"></ul>
<p class="pm-status status"></p>`;

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
    return node;
};

const far = (metres) => (!metres ? 'here'
    : metres < 1000 ? `${Math.round(metres)} m away`
        : `${(metres / 1000).toFixed(1)} km away`);

function row(entry, acts) {
    const go = el('button', { type: 'button', className: 'pm-go',
        textContent: 'Go and look' });
    go.onclick = () => acts.go(entry);
    const yes = el('button', { type: 'button', className: 'pm-yes primary',
        textContent: 'Approve' });
    yes.onclick = () => acts.approve(entry);
    const note = el('input', { type: 'text', className: 'pm-note',
        placeholder: 'why not (optional)' });
    const no = el('button', { type: 'button', className: 'pm-no',
        textContent: 'Refuse' });
    no.onclick = () => acts.refuse(entry, note.value);
    return el('li', { className: 'pm-entry' },
        el('div', {}, el('b', { textContent: `${entry.z}/${entry.x}/${entry.y}` }),
            el('span', { className: 'muted', textContent: ` ${far(entry.metres)}` })),
        el('div', { className: 'muted', textContent: entry.was_published
            ? 'replaces what is published there'
            : 'nothing is published there yet' }),
        el('div', { className: 'pm-acts' }, go, yes),
        el('div', { className: 'pm-acts' }, note, no));
}

// Say yes or no, then re-read the list and only then say what happened — a
// refresh that ran afterwards would wipe the one line that says it.
async function decided({ say, onDecided, refresh }, rpc, args, said) {
    let msg = said, bad = false;
    try {
        const ok = await api.rpc(rpc, args);
        if (!ok) { msg = 'somebody got there first — it is no longer waiting'; bad = true; }
    } catch (err) {
        msg = String(err.body?.message ?? err.message ?? err);
        bad = true;
    }
    onDecided();
    await refresh();
    say(msg, bad);
}

// The list, whatever there is to show: signed out, nothing waiting, or rows.
function fill(list, rows, acts) {
    if (!rows) {
        list.replaceChildren(el('li', { className: 'muted',
            textContent: 'sign in to see what is waiting on your land' }));
        return;
    }
    list.replaceChildren(...rows.map((r) => row(r, acts)));
    if (!rows.length) {
        list.append(el('li', { className: 'muted',
            textContent: 'nothing waiting: every rendered tile on your land'
                + ' has been approved' }));
    }
}

export function mountPermission(host, { streamer, onGo = () => {},
    where = () => ({}), onDecided = () => {}, onCount = () => {} } = {}) {
    const box = el('div');
    box.innerHTML = HTML;
    host.append(box);
    const q = (sel) => box.querySelector(sel);
    const say = (msg, bad = false) => {
        q('.pm-status').textContent = msg;
        q('.pm-status').dataset.bad = bad ? '1' : '';
    };

    const decide = (rpc, args, said) =>
        decided({ say, onDecided, refresh }, rpc, args, said);

    const acts = {
        go: (entry) => onGo(entry.centre ?? {}),
        approve: (entry) => decide('approve_tile',
            { z: entry.z, x: entry.x, y: entry.y },
            `${entry.z}/${entry.x}/${entry.y} is published — everybody sees it now`),
        refuse: (entry, note) => decide('refuse_tile',
            { z: entry.z, x: entry.x, y: entry.y, note: note || '' },
            `${entry.z}/${entry.x}/${entry.y} refused; it can be rendered again`),
    };

    async function refresh() {
        if (!api.token()) {
            fill(q('.pm-list'), null, acts);
            say('');
            onCount(0);
            return [];
        }
        const { lon, lat } = where() ?? {};
        const rows = await api.rpc('my_candidates',
            { lon: lon ?? null, lat: lat ?? null, limit: 40 }).catch(() => []);
        fill(q('.pm-list'), rows, acts);
        say(rows.length ? `${rows.length} waiting for you` : '');
        onCount(rows.length);
        return rows;
    }

    q('.pm-refresh').onclick = refresh;
    q('.pm-show').onchange = (e) => {
        if (streamer) streamer.candidates = e.target.checked;
        say(e.target.checked
            ? 'showing what is waiting — it may take a moment to load'
            : 'showing what is published');
    };

    refresh();
    return { refresh, acts, showing: () => q('.pm-show').checked };
}
