// flowrun.js — running a world flow on a process server of your own
// (TASKS-flows.md FL.7, db/0195).
//
// Everything that reaches the process server goes from this tab (Invariant 9):
// the ELX is sent as a process, a job is made for it, and the world issues the
// job a key of its own (deploy_flow), which the tab writes into the job's
// `world_key` input. The server then writes to the world with that key, under
// the same policies as anybody (Invariant 6). Stop withdraws the key; the
// process stays where it was sent.

import * as api from './api.js';
import * as flows from './flows.js';
import { processApi } from '../flow/server/process.js';
import { recordsApi } from '../flow/server/records.js';
import { buildInputsXml } from '../flow/server/inputs.js';
import { parseElx } from '../flow/elx/parse.js';

// Where this flow runs, as far as this player may see.
export const runsOf = (flowId) => api.select('flow_deployment', {
    select: 'id,flow_id,server_id,elx_sha256,remote_process_id,remote_job_id,created_at',
    flow_id: `eq.${flowId}`, revoked_at: 'is.null',
});

// The world's address for a job: where the World blocks send their writes.
export const worldUrl = () => new URL(api.endpoints().api, location.href).href.replace(/\/$/, '');

// What starts the job: nothing (run it now, once), a cron expression, or a
// check every minute for what happened here (World "Events since").
export function triggersFor(start) {
    if (start.kind === 'cron') return [{ type: 'cron', expression: start.expression }];
    if (start.kind === 'events') return [{ type: 'cron', expression: '* * * * *' }];
    return [];
}

// The process, sent or sent over: the one this flow was sent as before, else
// one of the same name, else a new one.
async function sendProcess(procs, flow, elx, before) {
    const there = before ? { id: before.remote_process_id }
        : (await procs.list()).find((p) => p.name === flow.name);
    if (there) {
        await procs.update(there.id, elx);
        return there.id;
    }
    return (await procs.create(flow.name, elx)).id;
}

export async function runOn(flow, server, start, say = () => {}) {
    const before = (await runsOf(flow.id)).find((d) => d.server_id === server.id);
    const elx = await flows.elxOf(flow.elx_sha256);
    const inputs = parseElx(elx).inputs;
    const recs = recordsApi(server.url);
    say('sending the flow…');
    const processId = await sendProcess(processApi(server.url), flow, elx, before);
    const job = (key) => ({ name: flow.name, group: '', processId, logLevel: 'info',
        storeReport: 'always', triggers: triggersFor(start),
        inputs: buildInputsXml(inputs, { world: worldUrl(), world_key: key }) });
    say('making the job…');
    const jobId = before ? before.remote_job_id : (await recs.createJob(job(''))).id;
    say('issuing the key…');
    const dep = await api.rpc('deploy_flow', { flow: flow.id, server: server.id,
        elx_sha256: flow.elx_sha256, process: String(processId), job: String(jobId) });
    await recs.updateJob(jobId, job(dep.key));
    if (start.kind === 'manual') await recs.runJob(jobId);
    say(`running on ${server.name}.`);
    return dep;
}

// Stop: the job is taken off the server, and the key withdrawn whether or not
// the server answered — a key is the world's to take back.
export async function stop(run, server) {
    let words = '';
    if (server) {
        await recordsApi(server.url).deleteJob(run.remote_job_id)
            .catch(() => {
                words = `${server.name} did not answer; the key is withdrawn anyway.`;
            });
    }
    await api.rpc('revoke_flow_key', { deployment: run.id });
    return words;
}
