// jobdialog.js — making or changing a job on a process server (TASKS-flows.md
// FL.5, docs/design/flows-servers.md §3c).
//
// A job is a process with its inputs bound, a log level, a report policy and
// the triggers that start it. The fields are the reference editor's
// (wireon-process-editor src/ui/jobeditor.js); a cron trigger is edited as a
// schedule (scheduleui.js, over its evaluator in flow/server/cron.js). The world keeps none
// of this — it is the server's.

import { el } from './poolui.js';
import { act } from './servertab.js';
import { scheduleEditor } from './scheduleui.js';
import { CRON_NOTE } from '../flow/server/schedule.js';
import { buildInputsXml, readInputsXml } from '../flow/server/inputs.js';
import { processApi } from '../flow/server/process.js';
import { parseElx } from '../flow/elx/parse.js';

// A trigger's kind, in the player's words (the artboard's tabs), and its fields.
const KIND_WORDS = { cron: 'on a schedule', http: 'on a request', filesystem: 'on a file',
    mqtt: 'on a message' };
const TRIGGERS = {
    cron: [],
    http: [['method', 'Method'], ['target', 'Target path'], ['inputNameRequest', 'Request input'],
        ['inputNameCaptures', 'Captures input'], ['outputNameResponse', 'Response output'],
        ['serviceId', 'Service']],
    filesystem: [['path', 'Path'], ['recursive', 'Recursive'], ['inputNameAction', 'Action input']],
    mqtt: [['serviceId', 'Service'], ['topic', 'Topic'], ['inputNameTopic', 'Topic input'],
        ['inputNamePayload', 'Payload input']],
};
export { CRON_NOTE };

const labelled = (label, input) => {
    input.setAttribute('aria-label', label);
    return el('label', { className: 'fl-field' }, el('span', { textContent: label }), input);
};
const choice = (values, value) => {
    const s = el('select', {}, ...values.map((v) => el('option', { value: v, textContent: v })));
    s.value = value;
    return s;
};

// A choice of a few words as a row of buttons (design 10h). The select stays,
// out of sight, as what is read and what a keyboard reaches.
function segmented(label, select) {
    select.setAttribute('aria-label', label);
    select.classList.add('fl-sr');
    const buttons = [...select.options].map((o) => {
        const b = el('button', { type: 'button', textContent: o.textContent });
        b.setAttribute('aria-pressed', String(select.value === o.value));
        b.onclick = () => {
            select.value = o.value;
            buttons.forEach((x, i) => x.setAttribute('aria-pressed',
                String(select.options[i].value === o.value)));
        };
        return b;
    });
    return el('div', { className: 'fl-field' }, el('span', { textContent: label }),
        el('div', { className: 'fl-seg' }, select, ...buttons));
}

// One trigger's fields. Services are offered by name, from the server's list.
function triggerRow(t, services, remove, openPlanner) {
    const read = [];
    const box = el('div', { className: 'fl-trigger' });
    box.dataset.type = t.type;
    box.append(el('h3', { textContent: KIND_WORDS[t.type] },
        el('span', { className: 'mono', textContent: t.type })));
    if (t.type === 'cron') {
        const sched = scheduleEditor(t.expression ?? '', { openPlanner });
        box.append(sched.node);
        read.push(['expression', sched.read]);
    }
    for (const [key, label] of TRIGGERS[t.type]) {
        let input;
        if (key === 'serviceId') {
            input = choice(['', ...services.map((s) => s.id)], t.serviceId ?? '');
            [...input.options].forEach((o) => {
                o.textContent = services.find((s) => s.id === o.value)?.name ?? '—';
            });
        } else if (key === 'recursive') {
            input = el('input', { type: 'checkbox', checked: Boolean(t.recursive) });
        } else {
            input = el('input', { type: 'text', value: t[key] ?? (key === 'method' ? 'GET' : '') });
        }
        box.append(labelled(label, input));
        read.push([key, () => (input.type === 'checkbox' ? input.checked : input.value.trim())]);
    }
    box.append(act('Remove', 'fl-trigger-del', () => { box.remove(); remove(); }));
    const values = () => Object.fromEntries(read.map(([k, f]) => [k, f()]));
    return { box, read: () => ({ type: t.type, ...values() }) };
}

// The process's own inputs, one field each, filled from what the job binds.
async function inputFields(host, server, processId, bound, locked) {
    host.replaceChildren();
    if (!processId) return () => ({ inputs: [], values: {} });
    const flow = parseElx(await processApi(server.url).elx(processId));
    const fields = flow.inputs.map((i) => {
        const input = el('input', { type: 'text', value: bound[i.name] ?? '' });
        // FL.7: a job made by Run on… binds these, and changing them by hand
        // would only break it.
        if (locked.has(i.name) && bound[i.name]) {
            input.readOnly = true;
            input.value = i.name === 'world_key' ? 'set by Run on…' : bound[i.name];
        }
        host.append(labelled(i.name, input));
        return [i, input];
    });
    return () => ({ inputs: flow.inputs, values: Object.fromEntries(fields.map(([i, f]) =>
        [i.name, f.readOnly ? bound[i.name] : f.value])) });
}

export function jobParts(job, processes) {
    const name = el('input', { type: 'text', value: job?.name ?? '' });
    const group = el('input', { type: 'text', value: job?.group ?? '' });
    const process = choice(['', ...processes.map((p) => p.id)], job?.processId ?? '');
    [...process.options].forEach((o) => {
        o.textContent = processes.find((p) => p.id === o.value)?.name ?? '—';
    });
    const level = choice(['info', 'debug', 'warn', 'error'], job?.logLevel ?? 'info');
    const store = choice(['never', 'on-error', 'always'], job?.storeReport ?? 'always');
    return { name, group, process, level, store };
}

// One button a kind (the artboard's "Add trigger · on a schedule · …"); the
// select and its Add stay, out of sight, as what a keyboard reaches.
function addTrigger(add) {
    const kind = choice(Object.keys(TRIGGERS), 'cron');
    kind.setAttribute('aria-label', 'Trigger type');
    kind.classList.add('fl-sr');
    return [el('span', { className: 'muted fl-add-word', textContent: 'Add trigger' }), kind,
        act('Add trigger', 'fl-trigger-add fl-sr', () => add({ type: kind.value })),
        ...Object.entries(KIND_WORDS).map(([k, w]) =>
            act(w, 'fl-trigger-kind', () => add({ type: k })))];
}

export function jobDialog(bag, { job, processes, services, locked = new Set() }, done) {
    const s = bag.server();
    const f = jobParts(job, processes);
    const inputs = el('div', { className: 'fl-job-inputs' });
    const triggers = el('div', { className: 'fl-job-triggers' });
    const rows = [];
    const openPlanner = bag.planner ? () => bag.planner.open() : null;
    const add = (t) => {
        const r = triggerRow(t, services, () => rows.splice(rows.indexOf(r), 1), openPlanner);
        rows.push(r);
        triggers.append(r.box);
    };
    (job?.triggers ?? []).forEach(add);
    let readInputs = () => ({ inputs: [], values: {} });
    const bound = readInputsXml(job?.inputs ?? '');
    const load = async () => {
        readInputs = await inputFields(inputs, s, f.process.value, bound, locked);
    };
    f.process.onchange = load;
    const err = el('p', { className: 'fl-err', hidden: true });
    const wrap = el('div', { className: 'fl-ask fl-job-dialog' });
    const save = act('Save', 'primary', async () => {
        try {
            const { inputs: ins, values } = readInputs();
            await done({ name: f.name.value.trim(), group: f.group.value.trim(),
                processId: f.process.value, logLevel: f.level.value, storeReport: f.store.value,
                inputs: buildInputsXml(ins, values), triggers: rows.map((r) => r.read()) });
            wrap.remove();
        } catch (e) {
            err.textContent = String(e?.message ?? e).replace(/^\d+ \S+: /, '');
            err.hidden = false;
        }
    });
    wrap.append(el('div', {},
        el('h3', { textContent: job ? 'Edit job' : 'New job' }),
        el('p', { className: 'fl-sub',
            textContent: job ? `${job.name} \u00b7 on ${s.name}` : `on ${s.name}` }),
        el('section', { className: 'fl-dsec' }, el('h4', { textContent: 'Job' }),
            el('div', { className: 'fl-grid3' }, labelled('Job name', f.name),
                labelled('Group', f.group), labelled('Process', f.process)),
            el('div', { className: 'fl-grid2' }, segmented('Log level', f.level),
                segmented('Store report', f.store))),
        el('section', { className: 'fl-dsec' }, el('h4', { textContent: 'Inputs' }), inputs),
        el('section', { className: 'fl-dsec' }, el('div', { className: 'fl-dsec-head' },
            el('h4', { textContent: 'Triggers' }), ...addTrigger(add)), triggers),
        err, el('div', { className: 'fl-acts' }, save, act('Cancel', '', () => wrap.remove()))));
    bag.dialogs().append(wrap);
    load().catch((e) => {
        err.textContent = String(e?.message ?? e);
        err.hidden = false;
    });
    return wrap;
}
