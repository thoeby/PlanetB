// planner.js: what the Planner draws, from jobs and reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, median, plannedRuns, rowsOf, statsOf, statusOf, tookWords, windowOf }
    from '../js/planner.js';

const DAY = Date.parse('2026-09-24T00:00:00Z');

test('a run ends as its report says', () => {
    assert.equal(statusOf({ code: 0 }), 'done');
    assert.equal(statusOf({ code: 0, warnings: 2 }), 'warned');
    assert.equal(statusOf({ code: 3 }), 'failed');
    assert.equal(statusOf({ running: true, code: 0 }), 'running');
});

test('the 24 h window is the day, the 6 h window is around now', () => {
    assert.deepEqual(windowOf(DAY, 24 * HOUR), { from: DAY, to: DAY + 24 * HOUR });
    const w = windowOf(DAY, 6 * HOUR, DAY + 12 * HOUR);
    assert.equal(w.from, DAY + 9 * HOUR);
    assert.equal(w.to, DAY + 15 * HOUR);
});

test('planned runs are the cron firings in the window, and only cron', () => {
    const job = { triggers: [{ type: 'cron', expression: '0 */6 * * *' },
        { type: 'http', target: '/x' }] };
    const got = plannedRuns(job, DAY + 5 * HOUR, DAY + 24 * HOUR);
    assert.deepEqual(got.map((p) => new Date(p.at).getUTCHours()), [6, 12, 18]);
    assert.deepEqual(plannedRuns({ triggers: [{ type: 'cron', expression: 'nonsense' }] },
        DAY, DAY + HOUR), []);
});

test('a job row holds its runs in view, the next run, and its numbers', () => {
    const jobs = [{ id: '9', name: 'Dusk',
        triggers: [{ type: 'cron', expression: '0 18 * * *' }] }];
    const reports = [
        { id: '1', jobId: '9', timestamp: '2026-09-23T18:00:00Z', code: 0, duration: 200 },
        { id: '2', jobId: '9', timestamp: '2026-09-24T10:00:00Z', code: 1, duration: 400 },
        { id: '3', jobId: '9', timestamp: '2026-09-24T11:00:00Z', code: 0, duration: 300 },
        { id: '4', jobId: '7', timestamp: '2026-09-24T11:00:00Z', code: 0 },
    ];
    const [row] = rowsOf(jobs, reports, { from: DAY, to: DAY + 24 * HOUR, now: DAY + 12 * HOUR });
    assert.deepEqual(row.runs.map((r) => r.id), ['2', '3']);
    assert.equal(row.all.length, 3);
    assert.equal(row.planned.length, 1);
    assert.equal(new Date(row.next.at).getUTCHours(), 18);
    assert.deepEqual(row.stats, { runs: 3, failed: 1, usual: 300, slowest: 400 });
    const failed = rowsOf(jobs, reports, { from: DAY, to: DAY + 24 * HOUR,
        now: DAY + 12 * HOUR, failedOnly: true })[0];
    assert.deepEqual(failed.runs.map((r) => r.id), ['2']);
});

test('the numbers read the way the column says them', () => {
    assert.equal(median([3, 1, 2, 10]), 2.5);
    assert.deepEqual(statsOf([]), { runs: 0, failed: 0, usual: 0, slowest: 0 });
    assert.equal(tookWords(212), '212 ms');
    assert.equal(tookWords(40_000), '40 s');
    assert.equal(tookWords(42 * 60_000), '42 min');
    assert.equal(tookWords(70 * 60_000), '1 h 10');
});
