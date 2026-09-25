// flowlist.js — the left column of the Automate view: every flow on land you
// build on, under the land it belongs to.
//
// A flow is not a file on your machine; it is on the land, and everybody who
// builds there has it. So Delete says whose it was and that it goes for all of
// them (SPEC §2.16), and Duplicate makes "Copy of …" on the same land.

import { el } from './poolui.js';

const copyName = (taken, name) => {
    let want = `Copy of ${name}`;
    for (let i = 2; taken.includes(want); i++) want = `Copy of ${name} ${i}`;
    return want;
};

// One small question, answered in the middle of the view. A prompt() would do
// the same job and cannot be styled or tested through the page.
export function ask(host, { title, value = '', ok = 'OK', onOk, onCancel, cancelWord }) {
    const input = el('input', { type: 'text', value, className: 'fl-ask-name' });
    const err = el('p', { className: 'fl-err', hidden: true });
    const wrap = el('div', { className: 'fl-ask' });
    const close = () => wrap.remove();
    const accept = async () => {
        try {
            await onOk(input.value.trim());
            close();
        } catch (e) {
            err.textContent = String(e?.message ?? e);
            err.hidden = false;
        }
    };
    const okBtn = el('button', { type: 'button', className: 'primary', textContent: ok });
    okBtn.onclick = accept;
    const stay = () => { close(); onCancel?.(); };
    const cancel = el('button', { type: 'button', className: 'fl-stay',
        textContent: cancelWord ?? (onCancel ? 'Stay' : 'Cancel') });
    cancel.onclick = stay;
    input.onkeydown = (e) => { if (e.key === 'Enter') accept(); if (e.key === 'Escape') stay(); };
    wrap.append(el('div', {},
        el('h3', { textContent: title }), input, err,
        el('div', { className: 'fl-acts' }, okBtn, cancel)));
    host.append(wrap);
    input.focus();
    input.select();
    return { node: wrap, input, err, close };
}

// Which land a new flow goes on: the ones you may build on, by name.
export function landPicker(lands) {
    const sel = el('select', { className: 'fl-land' });
    for (const a of lands) {
        sel.append(el('option', { value: a.id, textContent: a.name || 'unnamed land' }));
    }
    return sel;
}

// FL.6: which thing on that land the new flow belongs to, if any.
function thingPicker(landSel, objectsOn) {
    const sel = el('select', { className: 'fl-thing' });
    sel.setAttribute('aria-label', 'Belongs to');
    const fill = async () => {
        const things = objectsOn ? await objectsOn(landSel.value).catch(() => []) : [];
        sel.replaceChildren(el('option', { value: '', textContent: 'no thing' }),
            ...things.map((t) => el('option', { value: t.id, textContent: t.name })));
    };
    landSel.addEventListener('change', fill);
    fill();
    return sel;
}

// One flow's line: open it, rename it, copy it, or take it off the land.
function line(row, state, on) {
    const { rows, lands, openId, where } = state;
    const li = el('li');
    li.dataset.flow = row.id;
    li.dataset.on = row.id === openId ? '1' : '';
    const pick = el('button', { type: 'button', className: 'pick', textContent: row.name });
    pick.onclick = () => on.open(row);
    const rename = el('button', { type: 'button', className: 'ren', textContent: 'Ren' });
    rename.onclick = () => ask(where(), {
        title: `Rename ${row.name}`, value: row.name, ok: 'Rename',
        onOk: (name) => on.rename(row, name),
    });
    const dup = el('button', { type: 'button', className: 'dup', textContent: 'Dup' });
    dup.onclick = () => on.duplicate(row,
        copyName(rows.filter((r) => r.area_id === row.area_id).map((r) => r.name), row.name));
    const del = el('button', { type: 'button', className: 'del', textContent: 'Del' });
    del.onclick = () => {
        const land = lands.find((a) => a.id === row.area_id)?.name ?? 'this land';
        ask(where(), {
            title: `Delete flow ${row.name}? It is removed for everybody on ${land}.`,
            value: row.name, ok: 'Delete',
            onOk: (typed) => {
                if (typed !== row.name) throw new Error('Type the name to delete it.');
                return on.remove(row);
            },
        });
    };
    // Design 10a: where the flow runs, and whether it changed since it was sent.
    const run = state.runs?.get(row.id);
    const chip = run ? el('span', { className: 'fl-chip-run', textContent: run.changed
        ? `${run.server} \u00b7 changed since sent` : run.server }) : '';
    if (run) chip.dataset.tone = run.changed ? 'warn' : 'good';
    li.append(pick, chip, el('span', { className: 'fl-row-acts' }, rename, dup, del));
    return li;
}

// A land, then each thing on it that has flows, then the flows that belong
// to no thing — among them any whose thing was taken away (FL.6).
function drawLand(list, state, on, a, mine) {
    const land = el('li', { className: 'land' },
        el('span', { className: 'fl-caret', textContent: '\u25be' }),
        el('span', { className: 'fl-land-name', textContent: a.name || 'unnamed land' }),
        el('span', { className: 'fl-role', textContent: a.mine ? 'Owner' : 'Build grant' }));
    land.dataset.role = a.mine ? 'owner' : 'grant';
    list.append(land);
    const byThing = new Map();
    const loose = [];
    for (const r of mine) {
        const t = r.instance_id && state.things.get(r.instance_id);
        if (t && !t.gone) {
            if (!byThing.has(r.instance_id)) byThing.set(r.instance_id, []);
            byThing.get(r.instance_id).push(r);
        } else loose.push(r);
    }
    for (const [id, rs] of byThing) {
        const head = el('li', { className: 'thing' },
            el('span', { className: 'fl-caret', textContent: '\u25be' }),
            el('i', { className: 'fl-dia' }),
            el('span', { textContent: state.things.get(id).name }));
        head.dataset.thing = id;
        list.append(head);
        for (const r of rs) list.append(line(r, state, on));
    }
    if (loose.length && byThing.size) {
        list.append(el('li', { className: 'muted loose',
            textContent: 'Flows without a thing' }));
    }
    for (const r of loose) {
        const li = line(r, state, on);
        li.dataset.loose = byThing.size ? '1' : '';
        const was = r.instance_id && state.things.get(r.instance_id);
        if (was) {
            li.insertBefore(el('span', { className: 'muted fl-was',
                textContent: `was on ${was.name}` }), li.children[1]);
        }
        list.append(li);
    }
}

// Design 10j: name, land, and the thing it is for, each labelled.
function newFlowDialog(state, on) {
    const picker = landPicker(state.lands);
    const thing = thingPicker(picker, on.objectsOn);
    const box = ask(state.where(), {
        title: 'New flow', value: '', ok: 'Create',
        onOk: (name) => {
            if (!name) throw new Error('A flow needs a name.');
            return on.create(picker.value, name, thing.value || null);
        },
    });
    const label = (text, input) => el('label', { className: 'fl-field' },
        el('span', { textContent: text }), input);
    box.input.setAttribute('aria-label', 'Flow name');
    box.err.before(label('Name', box.input), label('Land', picker),
        label('Object \u00b7 optional', thing));
    box.input.focus();
}

export function mountFlowList(host, on) {
    const list = el('ul', { className: 'fl-list' });
    const empty = el('p', { className: 'muted fl-empty' });
    const newBtn = el('button', { type: 'button', className: 'primary fl-new',
        textContent: 'New flow' });
    const tally = el('span', { className: 'fl-tally' });
    host.append(el('div', { className: 'fl-tree' }, empty, list),
        el('div', { className: 'fl-foot' }, newBtn, tally));

    const state = { rows: [], lands: [], openId: null, things: new Map(), runs: new Map(),
        where: () => host.closest('#flows') ?? host };

    newBtn.onclick = () => newFlowDialog(state, on);

    function draw() {
        const { rows, lands } = state;
        list.replaceChildren();
        const byLand = new Map();
        for (const r of rows) {
            if (!byLand.has(r.area_id)) byLand.set(r.area_id, []);
            byLand.get(r.area_id).push(r);
        }
        for (const a of lands) drawLand(list, state, on, a, byLand.get(a.id) ?? []);
        newBtn.disabled = lands.length === 0;
        empty.textContent = lands.length === 0
            ? 'You build on no land yet, so there is nowhere to put a flow.'
            : (rows.length ? '' : `No flows on ${lands[0].name || 'your land'} yet — New flow`);
        empty.hidden = !empty.textContent;
        const used = new Set(rows.map((r) => r.area_id)).size;
        tally.textContent = `${rows.length} flow${rows.length === 1 ? '' : 's'} on ${used}`
            + ` land${used === 1 ? '' : 's'} \u00b7 ${state.runs.size} sent`;
    }

    return {
        node: host,
        set(nextRows, nextLands, nextOpen, things = new Map(), runs = new Map()) {
            state.runs = runs;
            state.rows = nextRows ?? [];
            state.lands = nextLands ?? [];
            state.openId = nextOpen ?? null;
            state.things = things;
            draw();
        },
        rows: () => state.rows,
        // The Flows page's New flow asks the same question (flowhome.js).
        newFlow: () => newFlowDialog(state, on),
    };
}
