// pool.js — Submit, and the pool anybody renders from.
//
// What you built has to be approved and then compiled before anyone else can
// see it, and compiling is somebody's browser doing the work. Submitting asks
// the land's approver; approving opens the jobs; a stranger takes one, runs it
// in their tab, and is paid when the tile lands.
//
// Neither panel decides anything. submit_area makes the submission,
// approve_submission opens the jobs, render_pool says what is waiting,
// claim_for hands out the work, and the escrow pays out on publish — all in
// db/0068_approvalfirst.sql, db/0043_pool.sql and the migrations under them.

import * as api from './api.js';
import { el, progressTiles } from './poolui.js';
export { mountPool } from './renderpool.js';

// ------------------------------------------------------------------ submit

export function mountSubmit(host, { onSubmitted = () => {}, onCount = () => {} } = {}) {
    const ui = submitParts();
    const state = { areas: [], progress: null, changes: null, mine: false };
    const say = (msg, bad = false) => {
        ui.status.textContent = msg;
        ui.status.dataset.bad = bad ? '1' : '';
    };
    layoutSubmit(host, ui);

    const chosenArea = () => state.areas.find((a) => a.id === ui.area.value);

    const draw = () => drawSubmit(ui, state);

    async function progress() {
        const chosen = chosenArea();
        state.mine = Boolean(chosen?.mine);
        state.progress = chosen
            ? await api.rpc('area_progress', { area_id: chosen.id }).catch(() => null)
            : null;
        state.changes = chosen
            ? await api.rpc('submission_changes', { area_id: chosen.id })
                .catch(() => null)
            : null;
        if (state.progress) onCount(state.progress);
        draw();
    }

    async function refresh() {
        state.areas = (await api.rpc('my_areas').catch(() => []))
            .filter((a) => a.may_write);
        ui.area.replaceChildren(...state.areas.map(
            (a) => new Option(a.rules?.name || 'unnamed land', a.id)));
        say(state.areas.length ? '' : 'no land of yours to submit');
        await progress();
        return state.areas;
    }

    const send = (opts) => sending(chosenArea(), ui, { say, refresh, onSubmitted },
        opts);

    ui.send.onclick = () => send();
    ui.mine.onclick = () => send({ andApprove: true });
    ui.area.onchange = progress;
    refresh();
    return { refresh, send, progress };
}

// SPEC §3.5: submitting sends it for a decision. Nothing is queued and nothing
// is paid for until somebody says yes (db/0068_approvalfirst.sql).
async function sending(chosen, ui, { say, refresh, onSubmitted },
    { andApprove = false } = {}) {
    if (!chosen) { say('pick some land first', true); return null; }
    ui.send.disabled = true;
    let said = '';
    let bad = false;
    let out = null;
    try {
        out = await api.rpc('submit_area',
            { area_id: chosen.id, note: ui.note.value });
        said = `${out.tiles} tile(s) awaiting approval`;
        if (andApprove) {
            const done = await api.rpc('approve_submission',
                { submission_id: out.id });
            said = `${out.tiles} tile(s) approved \u2014 ${done.queued} render`
                + ' job(s) are in the pool';
        }
    } catch (err) {
        said = String(err.body?.message ?? err.message ?? err);
        bad = true;
    }
    // Refresh first and say afterwards: refresh() writes its own line, and a
    // refresh that ran last would wipe the one line that says what happened.
    await refresh();
    if (out) onSubmitted(out);
    say(said, bad);
    return out;
}

function submitParts() {
    return {
        area: el('select', { className: 'su-area' }),
        tiles: el('div', { className: 'tiles' }),
        // SPEC §2.7: what the approver will see, before anything is sent, and
        // a note to them.
        changes: el('div', { className: 'note su-changes' }),
        note: el('input', { className: 'su-note', type: 'text',
            placeholder: 'anything the approver should know' }),
        send: el('button', {
            type: 'button', className: 'su-send primary', textContent: 'Submit',
        }),
        mine: el('button', { type: 'button', className: 'su-mine',
            textContent: 'Submit and approve' }),
        status: el('p', { className: 'su-status status' }),
    };
}

// How many tiles a Submit would ask about — the world's own count, from
// area_progress: exactly what submit_area() would pick up.
export function toSubmit(p) {
    return p ? Math.max(0, Number(p.to_submit ?? 0)) : 0;
}

// "3 tiles · 2 objects · 1 drawn" — what the approver is about to be shown.
function changeWords(n, changes) {
    const bits = [`${n} tile${n === 1 ? '' : 's'}`];
    if (changes?.objects) {
        bits.push(`${changes.objects} object${changes.objects === 1 ? '' : 's'}`);
    }
    if (changes?.moved) bits.push(`${changes.moved} moved`);
    if (changes?.features) bits.push(`${changes.features} drawn`);
    return bits.join(' \u00b7 ');
}

function drawSubmit(ui, state) {
    ui.tiles.replaceChildren(...progressTiles(state.progress));
    const n = toSubmit(state.progress);
    ui.changes.textContent = n
        ? `${changeWords(n, state.changes)} — this is what the approver sees.`
        : 'Nothing on this land has changed since it was last sent.';
    ui.send.textContent = n ? `Submit ${n} tile(s)` : 'Nothing to submit';
    ui.send.disabled = !n;
    ui.mine.disabled = !n || !state.mine;
    ui.mine.hidden = !state.mine;
}

function layoutSubmit(host, ui) {
    host.append(
        el('div', { className: 'section' },
            el('span', { className: 'label', textContent: 'Which land' }), ui.area),
        el('div', { className: 'section' },
            el('span', { className: 'label', textContent: 'Tiles on it' }), ui.tiles),
        el('div', { className: 'section' },
            el('span', { className: 'label', textContent: 'What is being sent' }),
            ui.changes, ui.note),
        el('div', { className: 'row' }, ui.send, ui.mine),
        el('div', { className: 'note',
            textContent: 'Approving is what opens the render jobs. A price can'
                + ' go on them afterwards, from Render; none is normal.' }),
        ui.status);
}

// -------------------------------------------------------------------- pool

