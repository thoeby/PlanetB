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
import { beforeWith, decide, el, tileId, waiting } from './permissionui.js';

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

// Go and look, then yes or no. A refusal without a note is refused here: the
// note is the only thing that reaches whoever rendered it.
function actionsOf(decideWith, onGo, say) {
    return {
        go: (entry) => onGo(entry.centre ?? {}),
        approve: (entry) => decideWith('approve_tile',
            { z: entry.z, x: entry.x, y: entry.y },
            `${tileId(entry)} is published — everybody sees it now`),
        refuse: (entry, note) => {
            if (!String(note ?? '').trim()) {
                say('a refusal carries a note back: say what is wrong with it', true);
                return Promise.resolve();
            }
            return decideWith('refuse_tile',
                { z: entry.z, x: entry.x, y: entry.y, note },
                `${tileId(entry)} refused; it can be rendered again`);
        },
    };
}

// The nodes the panel is made of, once.
function partsOf(host) {
    const ui = {
        scope: el('div', { className: 'note' }),
        toggle: el('div', { className: 'section' }),
        count: el('span', { className: 'label', textContent: 'Waiting for you' }),
        again: el('button', { type: 'button', className: 'pm-refresh',
            textContent: 'Refresh' }),
        list: el('ul', { className: 'rows' }),
        card: el('div', { className: 'section' }),
        status: el('p', { className: 'pm-status status' }),
    };
    ui.head = el('div', { className: 'spread' }, ui.count, ui.again);
    host.append(ui.scope, ui.toggle, ui.head, ui.list, ui.card, ui.status);
    return ui;
}

export function mountPermission(host, { streamer, onGo = () => {},
    where = () => ({}), onDecided = () => {}, onCount = () => {} } = {}) {
    const ui = partsOf(host);
    const { scope, toggle, count, list, card, status } = ui;

    const state = { rows: [], chosen: null, showing: false };
    const say = (msg, bad = false) => {
        status.textContent = msg;
        status.dataset.bad = bad ? '1' : '';
    };

    const decideWith = (rpc, args, said) =>
        decided({ say, onDecided, refresh }, rpc, args, said);

    const acts = actionsOf(decideWith, onGo, say);

    function draw() {
        toggle.replaceChildren(beforeWith(state.showing, (on) => {
            state.showing = on;
            if (streamer) streamer.candidates = on;
            say(on ? 'showing what is waiting — it may take a moment to load'
                : 'showing what is published');
            draw();
        }));
        count.textContent = state.rows?.length
            ? `${state.rows.length} waiting for you` : 'Waiting for you';
        list.replaceChildren(...waiting(state.rows, state.chosen,
            (e) => { state.chosen = tileId(e); draw(); }));
        const one = (state.rows ?? []).find((e) => tileId(e) === state.chosen);
        card.replaceChildren(...decide(one, acts));
    }

    async function refresh() {
        if (!api.token()) {
            state.rows = null;
            scope.textContent = '';
            draw();
            onCount(0);
            return [];
        }
        const { lon, lat } = where() ?? {};
        state.rows = await api.rpc('my_candidates',
            { lon: lon ?? null, lat: lat ?? null, limit: 40 }).catch(() => []);
        if (!state.rows.some((e) => tileId(e) === state.chosen)) {
            state.chosen = state.rows[0] ? tileId(state.rows[0]) : null;
        }
        scope.textContent = 'A rendered tile on land you decide for waits here'
            + ' until you look at it and say yes or no.';
        draw();
        onCount(state.rows.length);
        return state.rows;
    }

    ui.again.onclick = () => refresh();
    refresh();
    return { refresh, acts, showing: () => state.showing };
}
