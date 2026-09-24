// serverjobs.js — the Jobs section of "On <server>" (TASKS-flows.md FL.5,
// docs/design/flows-servers.md §3c).
//
// A server's jobs: what process each runs and what starts it. New and Edit open
// the job dialog (jobdialog.js); Run now asks the server to run it once and
// shows what came back in the panel under the canvas (serverreports.js).

import { el } from './poolui.js';
import { ask } from './flowlist.js';
import { recordsApi } from '../flow/server/records.js';
import { processApi } from '../flow/server/process.js';
import { failWords } from '../flow/server/client.js';
import { section, act } from './servertab.js';
import { jobDialog } from './jobdialog.js';

export const WORLD_INPUTS = new Set(['world', 'world_key']);

// What starts a job, in a few words: "cron 0 18 * * *", "http GET /x", "manual".
export function triggerWords(job) {
    const on = (job.triggers ?? []).filter((t) => t.enabled !== false);
    if (!on.length) return 'manual';
    return on.map((t) => (t.type === 'cron' ? `cron ${t.expression ?? ''}`
        : t.type === 'http' ? `http ${t.method ?? ''} ${t.target ?? ''}`
            : t.type === 'mqtt' ? `mqtt ${t.topic ?? ''}` : `${t.type} ${t.path ?? ''}`).trim())
        .join(' · ');
}

// What the dialog needs from the server before it can be drawn.
export async function forDialog(server) {
    const [processes, services] = await Promise.all([
        processApi(server.url).list(), recordsApi(server.url).services().catch(() => [])]);
    return { processes, services };
}

async function runNow(bag, job) {
    const s = bag.server();
    try {
        const summary = await recordsApi(s.url).runJob(job.id);
        if (!summary) { bag.say(`${s.name} ran ${job.name}`); return; }
        await bag.runPanel.show(s, { ...summary, jobName: job.name },
            `${s.name} does not stream runs — its report is below.`);
        bag.reload();
    } catch (e) {
        bag.say(failWords(e, s.name));
    }
}

function line(job, bag, reload) {
    const s = bag.server();
    const api = recordsApi(s.url);
    const li = el('li', { className: 'fl-remote' },
        el('span', { className: 'pick', textContent: job.name }),
        el('span', { className: 'muted', textContent: job.processName }),
        el('span', { className: 'muted mono fl-trig', textContent: triggerWords(job) }));
    li.dataset.job = job.name;
    li.append(
        act('Run now', 'run', () => runNow(bag, job)),
        act('Edit', 'edit', async () => jobDialog(bag,
            { job, ...(await forDialog(s)), locked: WORLD_INPUTS },
            (next) => api.updateJob(job.id, next).then(reload))),
        act('Del', 'del', () => ask(bag.dialogs(), {
            title: `Delete job ${job.name} on ${s.name}? It stops running.`,
            value: job.name, ok: 'Delete',
            onOk: (typed) => {
                if (typed !== job.name) throw new Error('Type the name to delete it.');
                return api.deleteJob(job.id).then(reload);
            },
        })));
    return li;
}

export function mountJobs(host, bag) {
    const add = act('New job', 'fl-new-job', async () => {
        const s = bag.server();
        jobDialog(bag, { job: null, ...(await forDialog(s)) }, async (job) => {
            if (!job.name) throw new Error('A job needs a name.');
            if (!job.processId) throw new Error('A job runs a process — choose one.');
            await recordsApi(s.url).createJob(job);
            part.run();
        });
    });
    // The Planner (plannerui.js): these jobs on a timeline.
    const planner = act('Planner', 'fl-planner-open', () => bag.planner?.open());
    const part = section(host, 'Jobs', {
        head: [add, planner],
        load: () => recordsApi(bag.server().url).jobs()
            .catch((e) => { throw new Error(failWords(e, bag.server().name)); }),
        draw(rows, list) {
            if (!list.length) {
                rows.append(el('li', { className: 'muted',
                    textContent: `${bag.server().name} has no jobs yet.` }));
            }
            for (const job of list) rows.append(line(job, bag, () => part.run()));
        },
    });
    return part;
}
