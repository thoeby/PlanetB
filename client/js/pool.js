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
import { steepRoads, steepWords } from './roadcheck.js';
import { el, progressTiles } from './poolui.js';
export { mountPool } from './renderpool.js';

// ------------------------------------------------------------------ submit

export function mountSubmit(host, { onSubmitted = () => {}, onCount = () => {},
    onGo = null, ground = null } = {}) {
    const ui = submitParts();
    const state = { areas: [], progress: null, changes: null, mine: false,
        flags: [], onGo };
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
        // The same measurement the compiler makes, made here so the owner
        // sees it before the approver does (client/js/roadcheck.js).
        state.flags = chosen && ground
            ? await steepRoads(chosen, ground).catch(() => [])
            : [];
        if (state.progress) onCount(state.progress);
        draw();
    }

    async function refresh() {
        state.areas = (await api.rpc('my_areas').catch(() => []))
            .filter((a) => a.may_write);
        ui.area.replaceChildren(...state.areas.map(
            (a) => new Option(a.rules?.name || 'unnamed land', a.id)));
        say(state.areas.length ? '' : 'No land of yours to submit — Land · 3.');
        await progress();
        return state.areas;
    }

    const send = (opts) => sending(chosenArea(), ui, { say, refresh, onSubmitted },
        opts);

    ui.send.onclick = () => send();
    ui.mine.onclick = () => send({ andApprove: true });
    ui.bare.onclick = () => compileAsItIs(chosenArea(), ui, { say, refresh });
    ui.area.onchange = progress;
    refresh();
    return { refresh, send, progress };
}

// "Build it from what is there now", for land that has nothing on it and so
// has nothing marked changed. It marks the ground and stops: from there it is
// Submit and an approval like anything else (db/0081_compileitagain.sql).
async function compileAsItIs(chosen, ui, { say, refresh }) {
    if (!chosen) { say('pick some land first', true); return; }
    ui.bare.disabled = true;
    try {
        const n = await api.rpc('recompile_land', { area_id: chosen.id });
        await refresh();
        say(`${n} tile(s) to build — send them when you are ready`);
    } catch (err) {
        await refresh();
        say(String(err.body?.message ?? err.message ?? err), true);
    }
    ui.bare.disabled = false;
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
            said = `${out.tiles} tile(s) approved \u2014 ${done.queued} render job(s)`
                + ` in the pool${done.published ? `, ${done.published} already published` : ''}`;
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
        // FND.11: roads laid across a slope steeper than their symbol allows.
        // A warning, never a refusal — with one button per place to go and
        // look at it.
        flags: el('div', { className: 'su-flags' }),
        note: el('input', { className: 'su-note', type: 'text',
            placeholder: 'anything the approver should know' }),
        send: el('button', {
            type: 'button', className: 'su-send primary', textContent: 'Submit',
        }),
        mine: el('button', { type: 'button', className: 'su-mine',
            textContent: 'Submit and approve' }),
        // Land nobody has drawn on has nothing changed about it, so there is
        // nothing to submit and no way to ask for it to be compiled at all —
        // a new owner met "Nothing to submit" and had to go and draw something
        // in QGIS before the world would render their ground. This is the ask
        // (db/0081_compileitagain.sql): build it from what is there now, which
        // for empty land is the ground and nothing else.
        bare: el('button', { type: 'button', className: 'su-bare',
            textContent: 'Compile it as it is' }),
        status: el('p', { className: 'su-status status' }),
    };
}

// How many tiles a Submit would ask about — the world's own count, from
// area_progress: exactly what submit_area() would pick up.
export function toSubmit(p) {
    return p ? Math.max(0, Number(p.to_submit ?? 0)) : 0;
}

// One line per place a road crosses a slope it should not, and a button that
// goes and looks at it. Nothing here refuses anything.
export function flagRows(state) {
    if (!state.flags?.length) return [];
    const rows = state.flags.slice(0, 12).map((f) => {
        const go = el('button', { type: 'button', className: 'su-go',
            textContent: 'Go' });
        go.onclick = () => state.onGo?.({ lon: f.lon, lat: f.lat, h: 0 });
        return el('div', { className: 'su-flag' },
            el('span', { textContent: `${f.name} \u00b7 ${(f.slope * 100).toFixed(0)} %` }),
            go);
    });
    return [el('div', { className: 'note', 'data-tone': 'warn',
        textContent: `${steepWords(state.flags)} \u2014 it can be sent anyway.` }),
    ...rows];
}

// "3 tiles · 2 objects · 5 drawn (3 highway · 2 building)" — what the approver
// is about to be shown. The kinds are named because since db/0135 there are
// nine of them, and somebody who has just pasted an extract into six layers
// wants to see the six counts rather than one number for all of it.
function kindWords(kinds) {
    const rows = Object.entries(kinds ?? {}).filter(([, n]) => n > 0);
    if (!rows.length) return '';
    rows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return ` (${rows.map(([kind, n]) => `${n} ${kind}`).join(' \u00b7 ')})`;
}

function changeWords(n, changes) {
    const bits = [`${n} tile${n === 1 ? '' : 's'}`];
    if (changes?.objects) {
        bits.push(`${changes.objects} object${changes.objects === 1 ? '' : 's'}`);
    }
    if (changes?.moved) bits.push(`${changes.moved} moved`);
    if (changes?.features) bits.push(`${changes.features} drawn${kindWords(changes.kinds)}`);
    // FND.9: a submission can be nothing but the ground, and an approver
    // looking at one was being shown nothing at all.
    if (changes?.ground) bits.push(`ground shaped (revision ${changes.ground})`);
    return bits.join(' \u00b7 ');
}

function drawSubmit(ui, state) {
    ui.tiles.replaceChildren(...progressTiles(state.progress));
    ui.flags.replaceChildren(...flagRows(state));
    const n = toSubmit(state.progress);
    const drawn = Number(state.changes?.features ?? 0)
        + Number(state.changes?.objects ?? 0) + Number(state.changes?.ground ?? 0);
    ui.changes.textContent = n
        ? `${changeWords(n, state.changes)} — this is what the approver sees.`
        : drawn
            ? 'Nothing on this land has changed since it was last sent.'
            : 'Nothing has been drawn or placed on this land. Compiling it as'
                + ' it is renders the ground itself, which is what anybody'
                + ' standing on it would see.';
    ui.send.textContent = n ? `Submit ${n} tile(s)` : 'Nothing to submit';
    ui.send.disabled = !n;
    ui.mine.disabled = !n || !state.mine;
    ui.mine.hidden = !state.mine;
    // Only where there is nothing to send: with changes waiting, sending them
    // is the thing to do and this would be a second button doing the same job.
    ui.bare.hidden = Boolean(n) || !state.mine;
}

function layoutSubmit(host, ui) {
    host.append(
        el('div', { className: 'section' },
            el('span', { className: 'label', textContent: 'Which land' }), ui.area),
        el('div', { className: 'section' },
            el('span', { className: 'label', textContent: 'Tiles on it' }), ui.tiles),
        el('div', { className: 'section' },
            el('span', { className: 'label', textContent: 'What is being sent' }),
            ui.changes, ui.flags, ui.note),
        el('div', { className: 'row' }, ui.send, ui.mine, ui.bare),
        el('div', { className: 'note',
            textContent: 'Approving is what opens the render jobs. A price can'
                + ' go on them afterwards, from Work; none is normal.' }),
        ui.status);
}

// -------------------------------------------------------------------- pool

