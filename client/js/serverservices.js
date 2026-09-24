// serverservices.js — the Services section of "On <server>" (TASKS-flows.md
// FL.4, docs/design/flows-servers.md §3b).
//
// A service is a configured instance of something a plugin provides — an HTTP
// server on a port, a database file. Which kinds there are comes from the
// chosen server's own plugins (their <service> definitions, parsed with the
// blocks); what each is set to is a <parameters> blob (flow/server/params.js,
// copied from the reference editor).

import { el } from './poolui.js';
import { ask } from './flowlist.js';
import { allServices } from '../flow/plugins/registry.js';
import { recordsApi } from '../flow/server/records.js';
import { failWords } from '../flow/server/client.js';
import { ApiError } from '../flow/server/envelope.js';
import { parseServiceParams, serializeServiceParams } from '../flow/server/params.js';
import { section, act } from './servertab.js';

const kind = (s) => `${s.pluginId ?? s.plugin}::${s.componentId ?? s.id}`;

// The reference documents PATCH and DELETE /service/<id> but a live server has
// been seen to answer "unknown request" to GET on that address; if it does to
// these too, the page says so rather than showing an HTTP code.
const noRecordRoute = (e) => e instanceof ApiError
    && (/unknown request/i.test(String(e.body)) || [400, 404, 405].includes(e.status));
const changeWords = (e, server) => (noRecordRoute(e)
    ? `${server} does not let this page change a service yet — its address for one`
        + ' service is missing.'
    : failWords(e, server));

// One field per parameter of the type: a switch, a choice, a number or text.
function paramField(p, value) {
    const label = p.name || p.id;
    let input;
    if (p.choices?.length) {
        input = el('select', {}, ...p.choices.map((c) =>
            el('option', { value: c.data, textContent: c.label || c.data })));
        input.value = value;
    } else if (p.default?.id === 'boolean') {
        input = el('input', { type: 'checkbox', checked: value === 'true' });
    } else {
        input = el('input', { type: p.default?.id === 'integer' ? 'number' : 'text', value });
    }
    input.setAttribute('aria-label', label);
    input.dataset.param = p.id;
    const read = () => (input.type === 'checkbox' ? String(input.checked) : input.value);
    return { read, row: el('label', { className: 'fl-field' },
        el('span', { textContent: label }), input) };
}

function serviceDialog(bag, existing, done) {
    const s = bag.server();
    const types = allServices().filter((d) => bag.visible(d.plugin));
    const type = el('select', {}, ...types.map((d) =>
        el('option', { value: kind(d), textContent: `${kind(d)} — ${d.name ?? d.id}` })));
    type.setAttribute('aria-label', 'Service type');
    if (existing) { type.value = kind(existing); type.disabled = true; }
    const name = el('input', { type: 'text', value: existing?.name ?? '' });
    name.setAttribute('aria-label', 'Service name');
    const fields = el('div');
    const err = el('p', { className: 'fl-err', hidden: true });
    let read = [];
    const have = parseServiceParams(existing?.parameters ?? '');
    const draw = () => {
        const def = types.find((d) => kind(d) === type.value);
        read = (def?.parameters ?? []).map((p) => {
            const f = paramField(p, have[p.id]?.data ?? p.default?.data ?? '');
            return [p.id, f.read, f.row];
        });
        fields.replaceChildren(...read.map((r) => r[2]));
    };
    type.onchange = draw;
    draw();
    const save = act('Save', 'primary', async () => {
        const def = types.find((d) => kind(d) === type.value);
        const svc = { name: name.value.trim(), pluginId: def.plugin, componentId: def.id,
            parameters: serializeServiceParams(def,
                Object.fromEntries(read.map(([id, get]) => [id, get()])), have) };
        try {
            await done(svc);
            wrap.remove();
        } catch (e) {
            err.textContent = String(e?.message ?? e).replace(/^\d+ \S+: /, '');
            err.hidden = false;
        }
    });
    const wrap = el('div', { className: 'fl-ask fl-svc-dialog' }, el('div', {},
        el('h3', { textContent: existing ? `${existing.name} on ${s.name}`
            : `A new service on ${s.name}` }),
        el('label', { className: 'fl-field' }, el('span', { textContent: 'Type' }), type),
        el('label', { className: 'fl-field' }, el('span', { textContent: 'Name' }), name),
        fields, err, el('div', { className: 'fl-acts' }, save,
            act('Cancel', '', () => wrap.remove()))));
    bag.dialogs().append(wrap);
}

function line(svc, bag, reload) {
    const s = bag.server();
    const api = recordsApi(s.url);
    const li = el('li', { className: 'fl-remote' },
        el('span', { className: 'pick', textContent: svc.name }),
        el('span', { className: 'muted mono', textContent: kind(svc) }));
    li.dataset.service = svc.name;
    li.append(
        act('Edit', 'edit', () => serviceDialog(bag, svc, async (next) => {
            await api.updateService(svc.id, next).catch((e) => {
                throw new Error(changeWords(e, s.name));
            });
            reload();
        })),
        act('Del', 'del', () => ask(bag.dialogs(), {
            title: `Delete service ${svc.name} on ${s.name}? Jobs and triggers that use it`
                + ' stop working.',
            value: svc.name, ok: 'Delete',
            onOk: async (typed) => {
                if (typed !== svc.name) throw new Error('Type the name to delete it.');
                await api.deleteService(svc.id).catch((e) => {
                    throw new Error(changeWords(e, s.name));
                });
                reload();
            },
        })));
    return li;
}

export function mountServices(host, bag) {
    const add = act('New service', 'fl-new-service', () => {
        const s = bag.server();
        const api = recordsApi(s.url);
        serviceDialog(bag, null, async (svc) => {
            if (!svc.name) throw new Error('A service needs a name.');
            if (await api.serviceExists(svc.name)) {
                throw new Error(`${s.name} already has a service called ${svc.name}.`);
            }
            await api.createService(svc);
            part.run();
        });
    });
    const part = section(host, 'Services', {
        head: [add],
        load: () => recordsApi(bag.server().url).services()
            .catch((e) => { throw new Error(failWords(e, bag.server().name)); }),
        draw(rows, list) {
            if (!list.length) {
                rows.append(el('li', { className: 'muted',
                    textContent: `${bag.server().name} has no services yet.` }));
            }
            for (const svc of list) rows.append(line(svc, bag, () => part.run()));
        },
    });
    return part;
}
