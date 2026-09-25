// schedule.js — a cron trigger as a player writes it (TASKS-flows.md FL.5,
// the operator's Edit job artboard): a preset — every N minutes between two
// times, every hour, every day at, weekdays at, or the expression itself —
// read into and out of the five fields, said as a sentence, and counted over a
// day. The server is the authority on when a job runs; everything here is the
// evaluator's reading (cron.js), shown as planned and never as a promise.

import { cronNextFirings, parseCron } from './cron.js';

export const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DOW = [1, 2, 3, 4, 5, 6, 0]; // cron's number for each of DAYS
export const PRESETS = [['minutes', 'Every … minutes'], ['hourly', 'Every hour'],
    ['daily', 'Every day at'], ['weekdays', 'Weekdays at'], ['custom', 'Custom']];
export const CRON_NOTE = 'A cron trigger checks at most once a minute.';
export const BAD_CRON = 'That is not a cron expression — five fields, minute first.';

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (h, m) => `${pad(h)}:${pad(m)}`;
const dowField = (days) => (days.length === 7 || !days.length ? '*'
    : days.map((d) => DOW[DAYS.indexOf(d)]).join(','));
const daysOf = (field) => {
    if (field === '*') return [...DAYS];
    const set = parseCronField(field);
    return DAYS.filter((d, i) => set.has(DOW[i]));
};
const parseCronField = (field) => parseCron(`0 0 * * ${field}`).dow;

// The expression for a schedule: {preset, every, from, to, days, at}.
export function cronOf(s) {
    const [fh, fm] = (s.from ?? '00:00').split(':').map(Number);
    const [th] = (s.to ?? '23:59').split(':').map(Number);
    const [ah, am] = (s.at ?? '00:00').split(':').map(Number);
    const dow = dowField(s.days ?? DAYS);
    switch (s.preset) {
    case 'minutes': {
        const every = Math.max(1, Math.min(59, Number(s.every) || 5));
        const hours = fh === 0 && th === 23 ? '*' : fh === th ? String(fh) : `${fh}-${th}`;
        return `${fm ? `${fm}-59/${every}` : `*/${every}`} ${hours} * * ${dow}`;
    }
    case 'hourly': return `${am} * * * ${dow}`;
    case 'daily': return `${am} ${ah} * * ${dow}`;
    case 'weekdays': return `${am} ${ah} * * 1-5`;
    default: return s.expression ?? '';
    }
}

// The schedule an expression reads as, or `custom` when it is none of the
// presets. Never throws: a bad expression is custom too.
export function scheduleOf(expression) {
    const parts = String(expression ?? '').trim().split(/\s+/);
    const custom = { preset: 'custom', expression };
    if (parts.length !== 5 || parts[2] !== '*' || parts[3] !== '*') return custom;
    const [min, hour, , , dow] = parts;
    let days;
    try { days = daysOf(dow); } catch { return custom; }
    if (dow === '1-5' && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
        return { preset: 'weekdays', at: hhmm(+hour, +min), days };
    }
    const step = /^(?:\*|(\d+)-59)\/(\d+)$/.exec(min);
    if (step && /^(\*|\d+(?:-\d+)?)$/.test(hour)) {
        const [lo, hi] = hour === '*' ? [0, 23] : hour.split('-').map(Number);
        return { preset: 'minutes', every: +step[2], from: hhmm(lo, +(step[1] ?? 0)),
            to: hhmm(hi ?? lo, 59 - ((59 - +(step[1] ?? 0)) % +step[2])), days };
    }
    if (!/^\d+$/.test(min)) return custom;
    if (hour === '*') return { preset: 'hourly', at: hhmm(0, +min), days };
    if (/^\d+$/.test(hour)) return { preset: 'daily', at: hhmm(+hour, +min), days };
    return custom;
}

const dayWords = (days) => (days.length === 7 ? 'every day'
    : days.join(',') === 'Mo,Tu,We,Th,Fr' ? 'on weekdays'
        : days.join(',') === 'Sa,Su' ? 'at weekends' : `on ${days.join(', ')}`);

// "Every 5 minutes from 17:00 to 22:55, every day."
export function scheduleWords(s) {
    const days = s.days ?? DAYS;
    switch (s.preset) {
    case 'minutes': return `Every ${s.every} minute${s.every === 1 ? '' : 's'} from ${s.from}`
        + ` to ${s.to}, ${dayWords(days)}.`;
    case 'hourly': return `Every hour at ${s.at.slice(3)} past, ${dayWords(days)}.`;
    case 'daily': return `Every day at ${s.at}${days.length === 7 ? '' : `, ${dayWords(days)}`}.`;
    case 'weekdays': return `Weekdays at ${s.at}.`;
    default: return `cron ${s.expression}`;
    }
}

// The firings on each of the next `n` days from `from`, as minutes of that
// day; [] for a day it does not fire. Throws when the expression is not one.
export function weekOf(expression, from = new Date(), n = 7) {
    const start = new Date(from);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + n);
    const out = Array.from({ length: n }, (_, i) => {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        return { day: d, minutes: [] };
    });
    for (const f of cronNextFirings(expression, new Date(start.getTime() - 1), n * 1440)) {
        if (f >= end) break;
        const i = Math.round((new Date(f).setHours(0, 0, 0, 0) - start.getTime()) / 86_400_000);
        out[i]?.minutes.push(f.getHours() * 60 + f.getMinutes());
    }
    return out;
}

// "72 runs a day · next at 18:05" — the usual day (the busiest of the next
// seven) and the first firing after now.
export function scheduleLine(expression, now = new Date()) {
    const week = weekOf(expression, now);
    const aDay = Math.max(...week.map((d) => d.minutes.length));
    const next = cronNextFirings(expression, now, 1)[0];
    const runs = aDay === 1 ? '1 run a day' : `${aDay} runs a day`;
    if (!next) return `${runs} · ${CRON_NOTE}`;
    const today = next.toDateString() === now.toDateString();
    const when = today ? hhmm(next.getHours(), next.getMinutes())
        : `${DAYS[(next.getDay() + 6) % 7]} ${hhmm(next.getHours(), next.getMinutes())}`;
    return `${runs} · next at ${when} · ${CRON_NOTE}`;
}
