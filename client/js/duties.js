// duties.js — somebody's flow, run on a process server of yours (LV.10).
//
// The world keeps an offer (db/0211 `duty`): an ELX by hash, a term, a
// bounty, and what the flow may touch. Taking one is this tab's doing from
// start to end (Invariant 9): the world issues a key for the land and the
// term (`claim_duty`), and the tab fetches the ELX by its hash, puts it on the
// chosen server as a process and a job with that key and the term's end, and
// has it run. What ran is reported back as receipts, one per run, read off the
// server's own reports; after the term anybody may settle it.

import * as api from './api.js';
import * as flows from './flows.js';
import { processApi } from '../flow/server/process.js';
import { recordsApi } from '../flow/server/records.js';
import { buildInputsXml } from '../flow/server/inputs.js';
import { parseElx } from '../flow/elx/parse.js';
import { worldUrl } from './flowrun.js';

// "00:01:00", "2 days" — a term as the pool says it.
export function termWords(term) {
    const m = /^(\d+):(\d\d):(\d\d)$/.exec(String(term ?? ''));
    if (!m) return String(term ?? '');
    const minutes = Number(m[1]) * 60 + Number(m[2]);
    if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} h`;
    return minutes ? `${minutes} min` : `${Number(m[3])} s`;
}

export const offerFlow = (flowId, minutes, bounty = 0) => api.rpc('offer_flow',
    { flow: flowId, term: `${Math.max(1, Number(minutes) || 60)} minutes`,
        bounty: Number(bounty) || 0 });

export const dutiesOpen = () => api.select('duty', {
    op: 'eq.flow', state: 'in.(open,claimed)', order: 'created_at.desc', limit: '50' });

// This tab's own runs, kept per tab so the receipts can be read again.
const KEY = 'splatworld.duties';
const store = () => globalThis.localStorage;
const mine = () => {
    try { return JSON.parse(store().getItem(KEY) ?? '{}'); } catch { return {}; }
};
const keep = (all) => {
    try { store().setItem(KEY, JSON.stringify(all)); } catch { /* a private window */ }
};

export async function runDuty(duty, server, say = () => {}) {
    say('taking it…');
    const got = await api.rpc('claim_duty', { duty: duty.id, server: server.id });
    const elx = await flows.elxOf(got.elx_sha256);
    const name = `duty-${duty.id.slice(0, 8)}`;
    say(`putting it on ${server.name}…`);
    const proc = await processApi(server.url).create(name, elx);
    const recs = recordsApi(server.url);
    const until = Math.floor(new Date(got.ends_at).getTime() / 1000);
    const job = await recs.createJob({ name, group: '', processId: proc.id, logLevel: 'info',
        storeReport: 'always', triggers: [], until,
        inputs: buildInputsXml(parseElx(elx).inputs,
            { world: worldUrl(), world_key: got.key }) });
    await recs.runJob(job.id);
    keep({ ...mine(), [duty.id]: { server: server.id, url: server.url, job: job.id, sent: [] } });
    say(`running on ${server.name} until ${new Date(got.ends_at).toLocaleTimeString()}.`);
    return { job: job.id, endsAt: got.ends_at };
}

// Every report of the job not yet said, said as a receipt.
export async function sendReceipts(dutyId) {
    const run = mine()[dutyId];
    if (!run) return 0;
    const reports = await recordsApi(run.url).reports(run.job).catch(() => []);
    let n = 0;
    for (const r of reports) {
        if (run.sent.includes(r.id)) continue;
        await api.rpc('duty_receipt', { duty: dutyId,
            receipt: { report: r.id, code: r.code ?? null, at: r.timestamp } });
        run.sent.push(r.id);
        n += 1;
    }
    keep({ ...mine(), [dutyId]: run });
    return n;
}

export const settleDuty = (dutyId) => api.rpc('settle_duty', { duty: dutyId });

export const runningHere = (dutyId) => Boolean(mine()[dutyId]);
