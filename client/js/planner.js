// planner.js — the jobs on a process server as a timeline (the Planner, after
// FL.5): what ran when, how it ended, how long it took, and what will run next.
//
// Pure: jobs and reports in (flow/server/records.js), rows out. The server is
// the authority on when a job runs; "planned" is the cron evaluator's reading
// of its triggers (flow/server/cron.js, the reference editor's), shown as
// planned and never as a promise.

import { cronNextFirings } from '../flow/server/cron.js';

export const HOUR = 3_600_000;
export const WINDOWS = { '6 h': 6 * HOUR, '24 h': 24 * HOUR, '7 days': 7 * 24 * HOUR };

// How a run ended, in the legend's words. A report with warnings and code 0 is
// "done with warnings"; a report the server has not finished is "running".
export function statusOf(r) {
    if (r.running) return 'running';
    if (r.skipped) return 'skipped';
    if (r.code === undefined) return 'done';
    if (r.code !== 0) return 'failed';
    return r.warnings > 0 ? 'warned' : 'done';
}

export const STATUS_WORDS = {
    done: 'done', warned: 'done with warnings', failed: 'failed',
    running: 'running', skipped: 'skipped, still running', planned: 'planned',
};

const at = (r) => Date.parse(r.timestamp ?? '') || null;

// The window a day's view shows: `span` long, ending at the end of the day it
// is on for 24 h and 7 days, centred on now for 6 h.
export function windowOf(day, span, now = Date.now()) {
    if (span <= 6 * HOUR) {
        const from = Math.min(now, day + 24 * HOUR) - span / 2;
        return { from, to: from + span };
    }
    const end = day + 24 * HOUR;
    return { from: end - span, to: end };
}

// Every time a job's cron triggers fire inside [from, to) — at most `max`.
export function plannedRuns(job, from, to, max = 400) {
    const out = [];
    for (const t of job.triggers ?? []) {
        if (t.type !== 'cron' || t.enabled === false || !t.expression) continue;
        let firings = [];
        try {
            firings = cronNextFirings(t.expression, new Date(from - 1), max);
        } catch {
            continue;
        }
        for (const d of firings) {
            const ms = d.getTime();
            if (ms >= to) break;
            out.push({ at: ms, trigger: `cron ${t.expression}` });
        }
    }
    return out.sort((a, b) => a.at - b.at);
}

export function median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// What the right-hand column says of a job, and what the chart under the
// lanes draws of it.
export function statsOf(runs) {
    const took = runs.map((r) => r.duration).filter((d) => Number.isFinite(d));
    return {
        runs: runs.length,
        failed: runs.filter((r) => r.status === 'failed').length,
        usual: median(took),
        slowest: took.length ? Math.max(...took) : 0,
    };
}

// One row per job: its runs in the window (newest last), its planned runs
// after now, and what it will do next.
export function rowsOf(jobs, reports, { from, to, now = Date.now(), failedOnly = false }) {
    return jobs.map((job) => {
        const all = reports.filter((r) => String(r.jobId) === String(job.id))
            .map((r) => ({ ...r, at: at(r), status: statusOf(r) }))
            .filter((r) => r.at !== null)
            .sort((a, b) => a.at - b.at);
        const inView = all.filter((r) => r.at < to && r.at + (r.duration ?? 0) >= from);
        const runs = failedOnly ? inView.filter((r) => r.status === 'failed') : inView;
        const planned = plannedRuns(job, Math.max(from, now), to);
        const next = plannedRuns(job, now, now + 8 * 24 * HOUR, 1)[0] ?? null;
        return { job, runs, all, planned, next, stats: statsOf(all) };
    });
}

// "42 min", "3 ms", "1 h 10": how long, as the right-hand column says it.
export function tookWords(ms) {
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
    if (ms < HOUR) return `${Math.round(ms / 60_000)} min`;
    const h = Math.floor(ms / HOUR);
    return `${h} h ${String(Math.round((ms % HOUR) / 60_000)).padStart(2, '0')}`;
}

// Where a time falls across the lane, 0..1.
export const xOf = (t, { from, to }) => (t - from) / (to - from);
