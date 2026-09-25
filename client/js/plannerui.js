// plannerui.js — the Planner: every job on the chosen process server as a lane
// on a timeline, what ran when and how it ended, and what will run next
// (planner.js has the arithmetic; plannerchart.js the chart under the lanes).
//
// It covers Automate while it is open and reads the server afresh on Refresh.
// Nothing here is kept in the world: jobs and reports are the server's.

import { el } from './poolui.js';
import { HOUR, WINDOWS, STATUS_WORDS, rowsOf, windowOf, xOf, tookWords } from './planner.js';
import { recordsApi } from '../flow/server/records.js';
import { failWords } from '../flow/server/client.js';
import { triggerWords, forDialog, WORLD_INPUTS } from './serverjobs.js';
import { jobDialog } from './jobdialog.js';
import { mountChart } from './plannerchart.js';
import { mountPopover } from './plannerpop.js';
import { mountRunPanel } from './serverreports.js';

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (t) => {
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayWords = (t) => new Date(t).toLocaleDateString(undefined,
    { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

const btn = (text, cls, onclick) => {
    const b = el('button', { type: 'button', className: cls, textContent: text });
    b.onclick = onclick;
    return b;
};

// Two or three buttons of which one is chosen.
function segmented(names, chosen, onPick) {
    const bs = names.map((n) => btn(n, 'pl-seg', () => { onPick(n); mark(n); }));
    const mark = (n) => bs.forEach((b) =>
        b.setAttribute('aria-pressed', String(b.textContent === n)));
    mark(chosen);
    return el('div', { className: 'pl-segs', role: 'group' }, ...bs);
}

function legend() {
    return el('div', { className: 'pl-legend' }, ...Object.entries(STATUS_WORDS).map(([k, w]) => {
        const key = el('span', { className: 'pl-key' });
        key.dataset.status = k;
        return el('span', {}, key, w);
    }));
}

// The hour marks across the top, and the line that is now.
function axisOf(view, now) {
    const step = view.to - view.from > 2 * 24 * HOUR ? 24 * HOUR : HOUR;
    const out = [];
    for (let t = Math.ceil(view.from / step) * step; t < view.to; t += step) {
        const m = el('span', { className: 'pl-tick mono',
            textContent: step === HOUR ? pad(new Date(t).getHours()) : new Date(t)
                .toLocaleDateString(undefined, { weekday: 'short' }) });
        m.style.left = `${xOf(t, view) * 100}%`;
        out.push(m);
    }
    if (now > view.from && now < view.to) {
        const n = el('span', { className: 'pl-now-label mono', textContent: hhmm(now) });
        n.style.left = `${xOf(now, view) * 100}%`;
        out.push(n);
    }
    return out;
}

function lane(row, view, now, on) {
    const l = el('div', { className: 'pl-lane' });
    for (const r of row.runs) {
        const b = btn('', 'pl-run', () => on.open(row, r, b));
        b.dataset.status = r.status;
        b.style.left = `${Math.max(0, xOf(r.at, view)) * 100}%`;
        const w = xOf(r.at + (r.duration ?? 0), view) - xOf(r.at, view);
        b.style.width = `${Math.max(0, w) * 100}%`;
        b.setAttribute('aria-label', `${row.job.name} ${hhmm(r.at)} · ${STATUS_WORDS[r.status]}`
            + ` · took ${tookWords(r.duration)}`);
        l.append(b);
    }
    for (const p of row.planned) {
        const m = el('span', { className: 'pl-plan',
            title: `planned ${hhmm(p.at)} · ${p.trigger}` });
        m.style.left = `${xOf(p.at, view) * 100}%`;
        l.append(m);
    }
    if (now > view.from && now < view.to) {
        const n = el('span', { className: 'pl-now' });
        n.style.left = `${xOf(now, view) * 100}%`;
        l.append(n);
    }
    return l;
}

function line(row, view, now, on, chosen) {
    const { job, next, stats } = row;
    const r = el('div', { className: 'pl-row' });
    r.dataset.job = job.name;
    r.dataset.chosen = chosen ? '1' : '';
    const today = next && new Date(next.at).toDateString() === new Date(now).toDateString();
    const weekday = next && !today
        ? `${new Date(next.at).toLocaleDateString(undefined, { weekday: 'short' })} ` : '';
    const nextWords = next ? `${weekday}${hhmm(next.at)}` : '—';
    const name = btn('', 'pl-name', () => on.choose(row));
    name.append(el('span', { className: 'pl-job', textContent: job.name }),
        el('span', { className: 'muted', textContent: job.processName ?? '' }),
        el('span', { className: 'muted mono', textContent: triggerWords(job) }));
    r.append(name, lane(row, view, now, on),
        el('div', { className: 'pl-next' },
            el('span', { className: 'mono', textContent: nextWords }),
            el('span', { className: 'muted', textContent: `${stats.runs} runs · ${stats.failed}`
                + ` failed · usually ${tookWords(stats.usual)}` })));
    return r;
}

// New job, Run now and Edit job: the job dialog and the run, then read again.
function actionsOf(bag, load, said) {
    const api = () => recordsApi(bag.server().url);
    return {
        async runNow(row) {
            await api().runJob(row.job.id)
                .catch((e) => { said.textContent = failWords(e, bag.server().name); });
            await load();
        },
        async edit(row) {
            const more = await forDialog(bag.server());
            jobDialog(bag, { job: row.job, ...more, locked: WORLD_INPUTS },
                (next) => api().updateJob(row.job.id, next).then(load));
        },
        async newJob() {
            jobDialog(bag, { job: null, ...(await forDialog(bag.server())) }, async (job) => {
                if (!job.name) throw new Error('A job needs a name.');
                if (!job.processId) throw new Error('A job runs a process — choose one.');
                await api().createJob(job);
                await load();
            });
        },
    };
}

// The day, the window, which runs, and what each colour and mark means.
function toolsOf(state, draw, date) {
    const shift = (days) => { state.day += days * 24 * HOUR; draw(); };
    return el('div', { className: 'pl-tools' },
        btn('\u2039', 'pl-prev', () => shift(-1)), date,
        btn('\u203a', 'pl-next-day', () => shift(1)),
        btn('Now', 'pl-today', () => { state.day = dayStart(Date.now()); draw(); }),
        segmented(Object.keys(WINDOWS), '24 h', (n) => { state.span = WINDOWS[n]; draw(); }),
        segmented(['All runs', 'Failed only'], 'All runs',
            (n) => { state.failedOnly = n === 'Failed only'; draw(); }),
        legend());
}

// Read the server's jobs and reports, and say what it said.
function loader(bag, state, parts, draw) {
    return async function load() {
        const s = bag.server();
        const api = recordsApi(s.url);
        try {
            [state.jobs, state.reports] = await Promise.all([api.jobs(), api.reports()]);
            parts.title.textContent = `\u00b7 ${state.jobs.length} jobs on ${s.name}`;
            parts.said.textContent = `${s.name} said: ${state.reports.length} reports`
                + ` \u00b7 ${hhmm(Date.now())}`;
            parts.said.dataset.tone = 'quiet';
        } catch (e) {
            parts.said.textContent = failWords(e, s.name);
            parts.said.dataset.tone = 'bad';
        }
        state.chosen = state.chosen ?? state.jobs[0]?.id ?? null;
        draw();
    };
}

export function mountPlanner(host, bag) {
    const state = { span: WINDOWS['24 h'], day: dayStart(Date.now()), failedOnly: false,
        jobs: [], reports: [], chosen: null, rows: [] };
    const parts = { title: el('span', { className: 'muted pl-count' }),
        said: el('span', { className: 'pl-said' }) };
    const date = el('span', { className: 'pl-date' });
    const head = el('div', { className: 'pl-axis' });
    const rows = el('div', { className: 'pl-rows' });
    const node = el('div', { className: 'fl-planner', hidden: true });
    const chart = mountChart(node);
    let acts = null;
    const pop = mountPopover(node, { run: (row) => acts.runNow(row), edit: (row) => acts.edit(row),
        report: (row, r) => report.show(bag.server(), { ...r, jobName: row.job.name }) });
    const choose = (row) => { state.chosen = row.job.id; pop.hide(); draw(); };
    function draw() {
        const now = Date.now();
        const view = windowOf(state.day, state.span, now);
        date.textContent = dayWords(state.day);
        state.rows = rowsOf(state.jobs, state.reports,
            { ...view, now, failedOnly: state.failedOnly });
        head.replaceChildren(...axisOf(view, now));
        const on = { open: (row, r, b) => pop.show(row, r, b, bag.server()), choose };
        rows.replaceChildren(...state.rows.map((row) =>
            line(row, view, now, on, row.job.id === state.chosen)));
        if (!state.rows.length) {
            rows.append(el('p', { className: 'muted',
                textContent: `${bag.server().name} has no jobs yet.` }));
        }
        chart.show(state.rows.find((x) => x.job.id === state.chosen) ?? null);
    }
    const load = loader(bag, state, parts, draw);
    acts = actionsOf(bag, load, parts.said);
    const close = () => { node.hidden = true; pop.hide(); };
    // Closed by the player, it hands the page back (flowsui.js, UI.8).
    const leave = () => { close(); bag.plannerClosed?.(); };
    node.append(
        el('div', { className: 'pl-top' },
            el('span', { className: 'name', textContent: 'Planner' }),
            parts.title, el('span', { className: 'spacer' }), parts.said,
            btn('New job', 'pl-new', () => acts.newJob()), btn('Refresh', 'pl-refresh', load),
            btn('Close', 'pl-close', leave)),
        toolsOf(state, draw, date),
        el('div', { className: 'pl-grid-head' },
            el('span', { className: 'muted', textContent: 'Job \u00b7 when it runs' }), head,
            el('span', { className: 'muted', textContent: 'Next \u00b7 today' })),
        rows, chart.node);
    // Its own report panel: the Automate one is under this view.
    const report = mountRunPanel(node);
    node.addEventListener('keydown', (e) => { if (e.key === 'Escape') leave(); });
    host.append(node);
    return { node, close, async open() { node.hidden = false; await load(); } };
}
