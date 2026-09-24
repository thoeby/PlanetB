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

const START = [['manual', 'Now, once', 'runs once, now'], ['cron', 'Every \u2026', 'cron'],
    ['events', 'When something happens here', 'polls World events every minute']];

// The cron field and its next five firings, in the world's time.
function cronField() {
    const cron = el('input', { type: 'text', value: '0 18 * * *', className: 'run-cron' });
    cron.setAttribute('aria-label', 'cron expression');
    const next = el('span', { className: 'build-run-next' });
    const preview = () => {
        try {
            next.textContent = cronNextFirings(cron.value.trim())
                .map((d) => d.toISOString().slice(11, 16)).join(' \u00b7 ');
            next.dataset.tone = 'quiet';
        } catch {
            next.textContent = 'That is not a cron expression \u2014 five fields, minute first.';
            next.dataset.tone = 'bad';
        }
    };
    cron.addEventListener('input', preview);
    preview();
    const node = el('div', { className: 'run-cronrow' }, cron,
        el('div', {}, el('span', { className: 'label', textContent: 'Next 5' }), next),
        el('p', { className: 'note', textContent: CRON_NOTE }));
    return { cron, node };
}

// Design 10k: what starts it, as three cards; the select stays for the
// keyboard and is what is read.
function startCards(cron) {
    const start = el('select', { className: 'run-hidden' }, ...START.map(([v, words]) =>
        el('option', { value: v, textContent: words })));
    start.setAttribute('aria-label', 'start');
    const cards = START.map(([v, words, kind]) => {
        const radio = el('input', { type: 'radio', name: 'run-start', value: v });
        radio.onchange = () => { start.value = v; mark(); };
        const card = el('label', { className: 'run-card' }, radio,
            el('span', { className: 'run-card-title', textContent: words }),
            el('span', { className: 'run-card-kind', textContent: kind }));
        card.dataset.start = v;
        if (v === 'cron') card.append(cron.node);
        return { card, radio, v };
    });
    const mark = () => cards.forEach((c) => {
        c.radio.checked = c.v === start.value;
        c.card.dataset.on = c.radio.checked ? '1' : '';
        if (c.v === 'cron') cron.node.hidden = !c.radio.checked;
    });
    start.onchange = mark;
    mark();
    return { start, node: el('div', { className: 'run-cards' }, start,
        ...cards.map((c) => c.card)) };
}

function runDialog(host, flow, thing, mine, done, current = null) {
    const server = el('select', {}, ...mine.map((s) =>
        el('option', { value: s.id, textContent: s.name })));
    if (current) server.value = mine.find((s) => s.name === current)?.id ?? server.value;
    const cron = cronField();
    const start = startCards(cron);
    const summary = el('p', { className: 'run-summary' });
    const go = el('button', { type: 'button', className: 'primary' });
    const words = () => {
        const s = mine.find((x) => x.id === server.value);
        summary.textContent = `Sends ${flow.name} to ${s?.name ?? '\u2026'}, makes job `
            + `${flow.name} there, and gives it a key that can change things on `
            + `${thing.land} only, for 30 days.`;
        go.textContent = `${current === s?.name ? 'Update' : 'Run'} on ${s?.name ?? '\u2026'}`;
    };
    server.onchange = words;
    words();
    const steps = el('ol', { className: 'run-steps' });
    const said = el('p', { className: 'status' });
    const close = el('button', { type: 'button', className: 'run-x', textContent: '\u00d7' });
    close.setAttribute('aria-label', 'Close');
    const cancel = el('button', { type: 'button', textContent: 'Cancel' });
    const box = el('div', { className: 'build-flows-ask build-run' },
        el('div', { className: 'run-head' }, el('h2', { textContent: 'Run on\u2026' }), close,
            el('p', { textContent: [flow.name, thing.name].filter(Boolean).join(' \u00b7 ') })),
        el('div', { className: 'run-body' }, labelled('server', server),
            el('span', { className: 'label', textContent: 'Start' }), start.node,
            summary, steps, said),
        el('div', { className: 'run-foot' }, cancel, go));
    const layer = el('div', { className: 'run-modal' }, box);
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); shut(); } };
    const shut = () => { layer.remove(); document.removeEventListener('keydown', esc, true); };
    document.addEventListener('keydown', esc, true);
    close.onclick = shut;
    cancel.onclick = shut;
    go.onclick = async () => {
        const s = mine.find((x) => x.id === server.value);
        try {
            await runOn(flow, s, { kind: start.start.value, expression: cron.cron.value.trim() },
                (t) => step(steps, said, t));
            shut();
            await done();
        } catch (e) {
            said.textContent = e?.name === 'ApiError' && e.errorCode !== undefined
                ? failWords(e, s.name) : plain(e);
            said.dataset.tone = 'bad';
        }
    };
    (host.closest?.('#flows') ?? document.getElementById('hud') ?? document.body).append(layer);
}

// Design 10k: what Run on… has done so far, one line a step.
function step(steps, said, t) {
    for (const li of steps.children) li.dataset.done = '1';
    steps.append(el('li', { textContent: t }));
    said.textContent = '';
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

// Run on… from Automate's own bar (design 10a): the same dialog, for the flow
// that is open, with the servers of the player's own.
export async function openRunDialog(host, flow, thing, done, say) {
    const mine = (await servers()).filter((s) => !s.fixed);
    if (!mine.length) { say('Add a process server of yours first.'); return; }
    runDialog(host, flow, thing, mine, done);
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
            ? runDialog(host, flow, thing, mine, reload, where?.name ?? null)
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
