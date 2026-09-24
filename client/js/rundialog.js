// rundialog.js — Run on… and Stop, on a flow's line in a thing's panel
// (TASKS-flows.md FL.7, docs/design/flows-servers.md §5a).
//
// Where the flow runs is shown on its line ("● alpha", and "changed since
// sent" when the flow was saved after it was sent). Run on… asks which of the
// player's servers and what starts it, and says what it is about to do before
// it does it.

import { el } from './poolui.js';
import { servers } from './processservers.js';
import { runsOf, runOn, stop } from './flowrun.js';
import { failWords } from '../flow/server/client.js';
import { CRON_NOTE } from './jobdialog.js';
import { cronNextFirings } from '../flow/server/cron.js';

const toned = (node, tone) => { node.dataset.tone = tone; return node; };
const plain = (e) => String(e?.message ?? e).replace(/^\d+ \S+: /, '');

function labelled(label, input) {
    input.setAttribute('aria-label', label);
    return el('label', {}, el('span', { className: 'label', textContent: label }), input);
}

function runDialog(host, flow, thing, mine, done) {
    const server = el('select', {}, ...mine.map((s) =>
        el('option', { value: s.id, textContent: s.name })));
    const start = el('select', {},
        el('option', { value: 'manual', textContent: 'Now, once' }),
        el('option', { value: 'cron', textContent: 'Every …' }),
        el('option', { value: 'events', textContent: 'When something happens here' }));
    const cron = el('input', { type: 'text', value: '0 18 * * *' });
    const next = el('span', { className: 'note build-run-next' });
    const preview = () => {
        try {
            next.textContent = `next 5 \u00b7 ${cronNextFirings(cron.value.trim())
                .map((d) => d.toISOString().slice(11, 16)).join(' \u00b7 ')}`;
            next.dataset.tone = 'quiet';
        } catch {
            next.textContent = 'That is not a cron expression \u2014 five fields, minute first.';
            next.dataset.tone = 'bad';
        }
    };
    cron.addEventListener('input', preview);
    preview();
    const cronRow = el('div', {}, labelled('cron expression', cron), next);
    cronRow.hidden = true;
    start.onchange = () => { cronRow.hidden = start.value !== 'cron'; };
    const summary = el('p', { className: 'note' });
    const words = () => {
        const s = mine.find((x) => x.id === server.value);
        summary.textContent = `Sends ${flow.name} to ${s?.name ?? '…'}, makes job `
            + `${flow.name} there, and gives it a key that can change things on `
            + `${thing.land} only, for 30 days.`;
    };
    server.onchange = words;
    words();
    const said = el('p', { className: 'status' });
    const wrap = el('div', { className: 'build-flows-ask build-run' },
        labelled('server', server), labelled('start', start), cronRow,
        el('p', { className: 'note', textContent: CRON_NOTE }), summary, said);
    const go = el('button', { type: 'button', className: 'primary', textContent: 'Run' });
    go.onclick = async () => {
        const s = mine.find((x) => x.id === server.value);
        try {
            await runOn(flow, s, { kind: start.value, expression: cron.value.trim() },
                (t) => {
                    said.textContent = t;
                    said.dataset.tone = t.startsWith('running on') ? 'good' : 'quiet';
                });
            wrap.remove();
            await done();
        } catch (e) {
            said.textContent = e?.name === 'ApiError' && e.errorCode !== undefined
                ? failWords(e, s.name) : plain(e);
            said.dataset.tone = 'bad';
        }
    };
    const cancel = el('button', { type: 'button', textContent: 'Cancel' });
    cancel.onclick = () => wrap.remove();
    wrap.append(el('div', { className: 'row' }, go, cancel));
    host.append(wrap);
}

function confirmHere(host, words, ok, onOk) {
    const yes = el('button', { type: 'button', className: 'primary', textContent: ok });
    const no = el('button', { type: 'button', textContent: 'Cancel' });
    const wrap = el('div', { className: 'build-flows-ask build-confirm' },
        toned(el('p', { className: 'status', textContent: words }), 'bad'),
        el('div', { className: 'row' }, yes, no));
    yes.onclick = async () => { wrap.remove(); await onOk(); };
    no.onclick = () => wrap.remove();
    host.append(wrap);
}

// The chip, Run on… and Stop for one flow's line. Filled when the world says
// where the flow runs.
export function runControls(flow, thing, { host, reload, say }) {
    const chip = el('span', { className: 'build-run-chip muted' });
    const runBtn = el('button', { type: 'button', className: 'run', textContent: 'Run on…' });
    const stopBtn = el('button', { type: 'button', className: 'stop', textContent: 'Stop',
        hidden: true });
    Promise.all([runsOf(flow.id).catch(() => []), servers()]).then(([runs, list]) => {
        const mine = list.filter((s) => !s.fixed);
        const run = runs[0];
        const where = run && mine.find((s) => s.id === run.server_id);
        if (run) {
            chip.textContent = `● ${where?.name ?? 'a server'}`
                + (run.elx_sha256 !== flow.elx_sha256 ? ' · changed since sent' : '');
            chip.dataset.tone = run.elx_sha256 !== flow.elx_sha256 ? 'warn' : 'good';
            runBtn.textContent = `Update on ${where?.name ?? 'the server'}`;
            stopBtn.hidden = false;
        }
        runBtn.onclick = () => (mine.length
            ? runDialog(host, flow, thing, mine, reload)
            : say('Add a process server of yours in Automate first.'));
        // Design 10l: Stop asks first, and says what it keeps and what it takes.
        stopBtn.onclick = () => {
            const on = where?.name ?? 'the server';
            confirmHere(host, `Stop ${flow.name} on ${on}? The process stays there; its key`
                + ' is withdrawn.', 'Stop', async () => {
                const gone = `${flow.name} stopped on ${on}; its key is withdrawn.`;
                say(await stop(run, where) || gone);
                await reload();
            });
        };
    });
    return [chip, runBtn, stopBtn];
}
