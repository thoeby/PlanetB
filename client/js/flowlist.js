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
export function ask(host, { title, value = '', ok = 'OK', onOk, onCancel }) {
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
        textContent: onCancel ? 'Stay' : 'Cancel' });
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
function landPicker(lands) {
    const sel = el('select', { className: 'fl-land' });
    for (const a of lands) {
        sel.append(el('option', { value: a.id, textContent: a.name || 'unnamed land' }));
    }
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
    li.append(pick, rename, dup, del);
    return li;
}

export function mountFlowList(host, on) {
    const list = el('ul', { className: 'fl-list' });
    const empty = el('p', { className: 'muted fl-empty' });
    const newBtn = el('button', { type: 'button', className: 'primary fl-new',
        textContent: 'New flow' });
    host.append(el('h3', { textContent: 'Flows' }),
        el('div', { className: 'fl-acts' }, newBtn), empty, list);

    const state = { rows: [], lands: [], openId: null,
        where: () => host.closest('#flows') ?? host };

    newBtn.onclick = () => {
        const picker = landPicker(state.lands);
        const box = ask(state.where(), {
            title: 'A new flow', value: '', ok: 'Create',
            onOk: (name) => {
                if (!name) throw new Error('A flow needs a name.');
                return on.create(picker.value, name);
            },
        });
        box.node.querySelector('div').insertBefore(picker, box.input);
    };

    function draw() {
        const { rows, lands } = state;
        list.replaceChildren();
        const byLand = new Map();
        for (const r of rows) {
            if (!byLand.has(r.area_id)) byLand.set(r.area_id, []);
            byLand.get(r.area_id).push(r);
        }
        for (const a of lands) {
            const mine = byLand.get(a.id) ?? [];
            list.append(el('li', { className: 'muted land',
                textContent: a.name || 'unnamed land' }));
            for (const r of mine) list.append(line(r, state, on));
        }
        newBtn.disabled = lands.length === 0;
        empty.textContent = lands.length === 0
            ? 'You build on no land yet, so there is nowhere to put a flow.'
            : (rows.length ? '' : `No flows on ${lands[0].name || 'your land'} yet — New flow`);
        empty.hidden = !empty.textContent;
    }

    return {
        node: host,
        set(nextRows, nextLands, nextOpen) {
            state.rows = nextRows ?? [];
            state.lands = nextLands ?? [];
            state.openId = nextOpen ?? null;
            draw();
        },
        rows: () => state.rows,
    };
}
