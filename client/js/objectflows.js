// objectflows.js — the Flows section of the Place panel (TASKS-flows.md FL.6,
// docs/design/flows-servers.md §5).
//
// A selected thing lists the flows that belong to it (db/0196). Whoever may
// build on its land can open one in Automate, add a new one made for it,
// attach one already on the land, or detach one; anybody else is shown what
// they may read and told why there is nothing to press. What may be read and
// changed is the database's to say (Invariant 6) — this only draws it.

import { el } from './poolui.js';
import * as flows from './flows.js';
import { runControls } from './rundialog.js';

const button = (text, cls, onclick) => {
    const b = el('button', { type: 'button', className: cls, textContent: text });
    b.onclick = onclick;
    return b;
};

// A small question in the panel itself: a name, or which flow to attach.
function askHere(host, label, input, ok, onOk) {
    const err = el('p', { className: 'status', hidden: true });
    const wrap = el('div', { className: 'build-flows-ask' },
        el('label', {}, el('span', { className: 'label', textContent: label }), input), err);
    input.setAttribute('aria-label', label);
    const go = button(ok, 'primary', async () => {
        try {
            await onOk(input.value);
            wrap.remove();
        } catch (e) {
            err.textContent = String(e?.message ?? e).replace(/^\d+ \S+: /, '');
            err.hidden = false;
        }
    });
    wrap.append(el('div', { className: 'row' }, go, button('Cancel', '', () => wrap.remove())));
    host.append(wrap);
    input.focus?.();
}

// Add flow: a new flow on the thing's land, belonging to it, made the way
// Automate makes one for a thing (flowsdo.js seedForThing), and opened there.
function addFlow(state, acts, on, reload) {
    const input = el('input', { type: 'text', value: '' });
    askHere(acts, 'name the flow', input, 'Create', async (name) => {
        if (!name.trim()) throw new Error('A flow needs a name.');
        await on.create?.(state.thing.area_id, name.trim(), state.thing.id);
        await reload();
    });
}

// Attach existing…: one of the land's flows that belongs to no thing yet.
async function attachExisting(state, { acts, said }, attach) {
    const loose = (await flows.flowsOn(state.thing.area_id)).filter((r) => !r.instance_id);
    if (!loose.length) {
        said.textContent = `Every flow on ${state.thing.land} already belongs to a thing.`;
        return;
    }
    const sel = el('select', {}, ...loose.map((r) =>
        el('option', { value: r.id, textContent: r.name })));
    askHere(acts, 'which flow', sel, 'Attach', (id) => attach(id, state.thing.id));
}

// One flow's line: Open for whoever may read it; for a builder also where it
// runs, Run on… and Stop (FL.7, rundialog.js), and Detach.
function flowLine(r, thing, { on, acts, said, reload, attach }) {
    const li = el('li', {}, el('span', { className: 'name', textContent: r.name }));
    li.dataset.flow = r.name;
    li.append(button('Open', 'open', () => on.open?.(r)));
    if (thing.mine) {
        li.append(...runControls(r, thing, { host: acts, reload,
            say: (t) => { said.textContent = t; said.dataset.tone = ''; } }),
        button('Detach', 'detach', () => attach(r.id, null)));
    }
    return li;
}

export function mountObjectFlows(host, on = {}) {
    const section = host.querySelector('.build-flows-section');
    const list = host.querySelector('.build-flows');
    const acts = host.querySelector('.build-flows-acts');
    const said = host.querySelector('.build-flows-said');
    const state = { thing: null, rows: [] };

    const draw = () => {
        const { thing, rows } = state;
        list.replaceChildren(...rows.map((r) =>
            flowLine(r, thing, { on, acts, said, reload, attach })));
        if (!rows.length) {
            const none = el('li', { textContent: `No flows on this ${thing.name} yet.` });
            none.dataset.tone = 'quiet';
            list.append(none);
        }
        acts.replaceChildren();
        if (thing.mine) {
            acts.append(button('Add flow', 'add', () => addFlow(state, acts, on, reload)),
                button('Attach existing…', 'attach',
                    () => attachExisting(state, { acts, said }, attach)));
        } else {
            said.dataset.tone = 'quiet';
            said.textContent = `Only people who build on ${thing.land} change its flows.`;
        }
    };

    // Attaching and detaching save the flow as it is now, not as it was when
    // this list was read: it may have been saved in Automate since.
    async function attach(id, instance) {
        try {
            await flows.attachFlow(await flows.getFlow(id), instance);
        } catch (e) {
            said.textContent = String(e?.message ?? e).replace(/^\d+ \S+: /, '');
            said.dataset.tone = 'bad';
        }
        await reload();
    }

    async function reload() {
        if (!state.thing) return;
        state.rows = await flows.flowsOf(state.thing.id).catch(() => []);
        draw();
    }

    return {
        reload,
        // `thing`: { id, area_id, name, land, mine } for the selected thing.
        async show(thing) {
            if (thing?.id !== state.thing?.id) said.textContent = '';
            state.thing = thing;
            section.hidden = !thing;
            if (!thing) { list.replaceChildren(); acts.replaceChildren(); return; }
            await reload();
        },
    };
}
