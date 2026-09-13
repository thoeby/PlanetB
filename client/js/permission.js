// permission.js — what stands on the land waits for a person.
//
// SPEC §0.2: approval comes before rendering, like a permit comes before
// building. What is approved is what stands on the tile — the saved objects
// and the land features, seen in place as models — and rendering is then
// mechanical: it publishes when it lands, and nobody is asked twice.
//
// It was the other way round until db/0068_approvalfirst.sql: a stranger
// rendered first and the owner approved the picture. That spent somebody's tab
// on work that might be thrown away, and asked the owner about a render when
// what they care about is what was built.

import * as api from './api.js';
import { beforeAfter, decide, el, waiting } from './permissionui.js';

// Say yes or no, then re-read the list and only then say what happened — a
// refresh that ran afterwards would wipe the one line that says it.
async function decided({ say, onDecided, refresh }, rpc, args, said) {
    let msg = said;
    let bad = false;
    try {
        await api.rpc(rpc, args);
    } catch (err) {
        msg = String(err.body?.message ?? err.message ?? err);
        bad = true;
    }
    onDecided();
    await refresh();
    say(msg, bad);
}

// Go and look, then yes or no. A refusal without a note is refused here as
// well as in the database: the note is the only thing that reaches whoever
// built it.
function actionsOf(decideWith, ctx, say) {
    return {
        review: (entry) => {
            ctx.onGo({ lon: entry.lon, lat: entry.lat });
            say('Reviewing in place. Before / After shows what was built.');
        },
        approve: (entry) => decideWith('approve_submission',
            { submission_id: entry.id },
            `${entry.land} is queued — its render jobs are in the pool`),
        refuse: (entry, note) => {
            if (String(note ?? '').trim().length < 10) {
                say('say why, in a sentence — a refusal without a reason is not'
                    + ' something anybody can act on', true);
                return Promise.resolve();
            }
            return decideWith('refuse_submission',
                { submission_id: entry.id, note },
                `${entry.land} was refused; the note went back with it`);
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

export function mountPermission(host, { onGo = () => {}, preview = null,
    onDecided = () => {}, onCount = () => {} } = {}) {
    const ui = partsOf(host);
    const { scope, toggle, count, list, card, status } = ui;

    const state = { rows: [], chosen: null, after: true };
    const say = (msg, bad = false) => {
        status.textContent = msg;
        status.dataset.bad = bad ? '1' : '';
    };

    const decideWith = (rpc, args, said) =>
        decided({ say, onDecided, refresh }, rpc, args, said);
    const acts = actionsOf(decideWith, { onGo }, say);

    function draw() {
        toggle.replaceChildren(beforeAfter(state.after, (on) => {
            state.after = on;
            // What was built is what is being approved: hiding it is "before".
            preview?.setVisible?.(on);
            say(on ? 'showing what was built' : 'showing the land without it');
            draw();
        }));
        count.textContent = state.rows?.length
            ? `${state.rows.length} waiting for you` : 'Waiting for you';
        list.replaceChildren(...waiting(state.rows, state.chosen,
            (e) => { state.chosen = e.id; draw(); }));
        card.replaceChildren(...decide(
            (state.rows ?? []).find((e) => e.id === state.chosen), acts));
    }

    async function refresh() {
        if (!api.token()) {
            state.rows = [];
            scope.textContent = '';
            draw();
            onCount(0);
            return [];
        }
        state.rows = await api.rpc('submissions_waiting').catch(() => []);
        if (!state.rows.some((e) => e.id === state.chosen)) {
            state.chosen = state.rows[0]?.id ?? null;
        }
        scope.textContent = 'What somebody built on land you decide for waits'
            + ' here until you look at it and say yes or no. Approving opens'
            + ' its render jobs; what lands is published.';
        draw();
        onCount(state.rows.length);
        return state.rows;
    }

    ui.again.onclick = () => refresh();
    refresh();
    return { refresh, acts, after: () => state.after };
}
