// scheduleui.js — the "On a schedule" trigger of the job dialog (jobdialog.js),
// as the operator's Edit job artboard draws it: a preset row, the fields the
// preset needs, the sentence and the expression beside "Edit as text", the
// line under it (runs a day, next at, the once-a-minute note) and the next
// seven days as ticks, with Open in planner. flow/server/schedule.js does the
// reading; the server is the authority on when a job runs.

import { el } from './poolui.js';
import { act } from './servertab.js';
import { BAD_CRON, DAYS, PRESETS, cronOf, scheduleOf, scheduleLine, scheduleWords, weekOf }
    from '../flow/server/schedule.js';

const pressed = (b, on) => b.setAttribute('aria-pressed', String(on));
const isPressed = (b) => b.getAttribute('aria-pressed') === 'true';

// A row of buttons of which one is pressed, over the hidden select that is read.
function presetRow(select, onPick) {
    const bs = [...select.options].map((o) => {
        const b = el('button', { type: 'button', textContent: o.textContent });
        b.onclick = () => { select.value = o.value; mark(); onPick(); };
        return b;
    });
    const mark = () => bs.forEach((b, i) => pressed(b, select.options[i].value === select.value));
    select.onchange = () => { mark(); onPick(); };
    mark();
    return { node: el('div', { className: 'fl-seg fl-presets' }, select, ...bs), mark };
}

// Mo … Su as toggles.
function dayRow(chosen, onChange) {
    const bs = DAYS.map((d) => {
        const b = el('button', { type: 'button', textContent: d, className: 'fl-day' });
        pressed(b, chosen.includes(d));
        b.onclick = () => { pressed(b, !isPressed(b)); onChange(); };
        return b;
    });
    return { node: el('div', { className: 'fl-days' }, ...bs),
        read: () => DAYS.filter((d, i) => isPressed(bs[i])) };
}

// The next seven days, a lane each, a tick a firing.
function week(expression, host) {
    host.replaceChildren();
    let days;
    try { days = weekOf(expression); } catch { return; }
    for (const d of days) {
        const lane = el('div', { className: 'fl-week-lane' });
        for (const m of d.minutes) {
            const t = el('i');
            t.style.left = `${(m / 1440) * 100}%`;
            lane.append(t);
        }
        host.append(el('span', { className: 'muted', textContent: d.day
            .toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) }), lane);
    }
}

const word = (t) => el('span', { textContent: t });

// The inputs a schedule is made of, filled from what the expression reads as.
function inputs(s, onInput) {
    const time = (value, label) => {
        const i = el('input', { type: 'time', value, className: 'fl-time' });
        i.setAttribute('aria-label', label);
        i.oninput = onInput;
        return i;
    };
    const every = el('input', { type: 'number', min: 1, max: 59, value: s.every ?? 5 });
    every.setAttribute('aria-label', 'Every minutes');
    every.oninput = onInput;
    const from = time(s.from ?? '00:00', 'From');
    const to = time(s.to ?? '23:59', 'To');
    const at = time(s.at ?? '18:00', 'At');
    const days = dayRow(s.days ?? DAYS, onInput);
    const fields = {
        minutes: [word('Every'), every, word('minutes, from'), from, word('to'), to, word('on')],
        hourly: [word('At'), at, word('past the hour, on')],
        daily: [word('At'), at, word('on')],
        weekdays: [word('At'), at],
        custom: [el('span', { className: 'muted',
            textContent: 'Five fields: minute, hour, day of month, month, day of week.' })],
    };
    const show = (preset) => el('div', { className: 'fl-sched-fields' }, ...fields[preset],
        ...(preset === 'minutes' || preset === 'hourly' || preset === 'daily' ? [days.node] : []));
    const read = (preset) => ({ preset, every: Number(every.value), from: from.value,
        to: to.value, at: at.value, days: days.read() });
    return { show, read };
}

export function scheduleEditor(expression, { openPlanner } = {}) {
    const preset = el('select', { className: 'fl-sr' }, ...PRESETS.map(([v, w]) =>
        el('option', { value: v, textContent: w })));
    preset.setAttribute('aria-label', 'Schedule');
    preset.value = scheduleOf(expression || '*/5 * * * *').preset;
    const text = el('input', { type: 'text', value: expression, className: 'mono' });
    text.setAttribute('aria-label', 'Expression');
    const textBox = el('div', { className: 'fl-cron-text', hidden: true }, text);
    const out = { says: el('p', { className: 'fl-cron-says' }),
        expr: el('span', { className: 'mono muted fl-cron-expr' }),
        line: el('p', { className: 'muted fl-cron-line' }),
        lanes: el('div', { className: 'fl-week' }),
        body: el('div', { className: 'fl-sched-body' }) };
    // The fields write the expression; the expression, typed, re-reads the fields.
    const fromFields = () => { text.value = cronOf(ins.read(preset.value)); draw(); };
    let ins = inputs(scheduleOf(expression || '*/5 * * * *'), fromFields);
    const presets = presetRow(preset, () => {
        if (preset.value === 'custom') textBox.hidden = false; else fromFields();
        draw();
    });
    text.oninput = () => {
        const s = scheduleOf(text.value);
        preset.value = s.preset;
        if (s.preset !== 'custom') ins = inputs(s, fromFields);
        presets.mark();
        draw();
    };
    function draw() {
        const e = text.value.trim();
        const s = preset.value === 'custom' ? scheduleOf(e) : ins.read(preset.value);
        out.body.replaceChildren(ins.show(preset.value));
        out.expr.textContent = e;
        out.says.textContent = scheduleWords(s);
        try { out.line.textContent = scheduleLine(e); out.line.dataset.tone = ''; } catch {
            out.line.textContent = BAD_CRON;
            out.line.dataset.tone = 'bad';
        }
        week(e, out.lanes);
    }
    const asText = act('Edit as text', 'fl-cron-astext', () => {
        textBox.hidden = !textBox.hidden;
        if (!textBox.hidden) text.focus();
    });
    const planner = act('Open in planner', 'fl-cron-planner', () => openPlanner?.());
    planner.hidden = !openPlanner;
    const node = el('div', { className: 'fl-sched' }, presets.node, out.body,
        el('div', { className: 'fl-cron-summary' },
            el('div', {}, out.says, out.line), el('div', {}, out.expr, asText)),
        textBox,
        el('div', { className: 'fl-week-head' },
            el('span', { className: 'muted', textContent: 'The next 7 days' }), planner),
        out.lanes);
    if (preset.value === 'custom') textBox.hidden = false; else fromFields();
    draw();
    return { node, read: () => text.value.trim() };
}
