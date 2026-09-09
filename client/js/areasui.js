// areasui.js — the area panel: my land, who may touch it, and what they have
// asked to change.
//
// Plain DOM. Every button here is one RPC, and every refusal comes back from
// the database rather than from a check in this file (Invariant 6).

import { RIGHTS, approve, areaGrants, describeDiff, grant, merge, myAreas,
    myProposals, revoke, setRequiredApprovals } from './areas.js';

const HTML = `
<div class="area-head">areas</div>
<ul class="area-list"></ul>
<div class="area-grants" hidden>
  <div class="area-rules">
    <label>approvals needed <input class="area-approvals" type="number" min="1" value="1">
    </label>
  </div>
  <ul class="area-granted"></ul>
  <div class="area-add">
    <input class="area-email" type="email" placeholder="email">
    <select class="area-right"></select>
    <button type="button" class="area-give">grant</button>
  </div>
</div>
<div class="area-head">proposals</div>
<ul class="area-proposals"></ul>
<p class="area-status muted"></p>`;

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
    return node;
};

const short = (id) => String(id ?? '').slice(0, 8);

// --------------------------------------------------------------------- rows

function areaRow(area, onPick, selected) {
    const b = el('button', { type: 'button',
        textContent: `${short(area.id)} · detail ${area.detail}`
            + `${area.mine ? ' · mine' : area.may_write ? ' · writer' : ' · proposer'}` });
    b.onclick = () => onPick(area);
    const li = el('li', { className: 'area-item' }, b);
    li.dataset.on = area.id === selected ? '1' : '';
    return li;
}

function grantRow(areaId, g, onRevoke) {
    const b = el('button', { type: 'button', textContent: 'revoke' });
    b.onclick = () => onRevoke(areaId, g);
    return el('li', { className: 'area-grant' },
        el('span', { textContent: `${g.email ?? short(g.grantee_id)} · ${g.right_} ` }), b);
}

// A proposal shows what it would do before anyone agrees to it.
function proposalRow(p, acts) {
    const li = el('li', { className: 'area-proposal' });
    li.dataset.id = p.id;
    li.append(el('div', { className: 'muted',
        textContent: `${short(p.id)} · ${p.mine ? 'mine' : short(p.author_id)}`
            + ` · ${p.approvals}/${p.required} approvals` }));
    for (const line of describeDiff(p.diff)) {
        li.append(el('div', { className: 'area-op', textContent: line }));
    }
    if (p.may_approve) {
        const ok = el('button', { type: 'button', className: 'area-approve',
            textContent: p.approved ? 'approved' : 'approve', disabled: p.approved });
        ok.onclick = () => acts.approve(p);
        const go = el('button', { type: 'button', className: 'area-merge',
            textContent: 'merge', disabled: p.approvals < p.required });
        go.onclick = () => acts.merge(p);
        li.append(el('div', { className: 'area-acts' }, ok, go));
    }
    return li;
}

// -------------------------------------------------------------------- mount

// Approving and merging are two calls, not one: reaching the threshold does
// not merge, so the last approver still decides when the world changes.
function actions(refresh, say, fail) {
    return {
        approve: async (p) => {
            try { say(`approved: ${await approve(p.id)}`); } catch (err) { fail(err); }
            await refresh();
        },
        merge: async (p) => {
            try { say(`merged ${await merge(p.id)} op(s)`); } catch (err) { fail(err); }
            await refresh();
        },
    };
}

export function mountAreas(host, { onSelect } = {}) {
    host.innerHTML = HTML;
    const q = (sel) => host.querySelector(sel);
    const state = { areas: [], selected: null };
    for (const r of RIGHTS) q('.area-right').append(new Option(r, r));

    // The class is what the panel is found by, so only the modifier changes:
    // assigning className outright would drop `area-status` and the element
    // would vanish from every selector that names it.
    const say = (msg, bad = false) => {
        const node = q('.area-status');
        node.textContent = msg;
        node.className = `area-status ${bad ? 'bad' : 'muted'}`;
    };
    const fail = (err) => say(String(err.body?.message ?? err.message ?? err), true);

    async function showGrants(area) {
        state.selected = area?.id ?? null;
        q('.area-grants').hidden = !area?.mine;
        if (!area?.mine) return;
        q('.area-approvals').value = area.rules?.required_approvals ?? 1;
        const rows = await areaGrants(area.id).catch(() => []);
        q('.area-granted').replaceChildren(...rows.map((g) => grantRow(area.id, g, onRevoke)));
    }

    async function pick(area) {
        await showGrants(area);
        q('.area-list').replaceChildren(
            ...state.areas.map((a) => areaRow(a, pick, state.selected)));
        onSelect?.(area);
    }

    async function onRevoke(areaId, g) {
        try {
            await revoke(areaId, g.grantee_id, g.right_);
            await refresh();
        } catch (err) { fail(err); }
    }

    const acts = actions(() => refresh(), say, fail);

    async function refresh() {
        const [areas, proposals] = await Promise.all([
            myAreas().catch(() => []), myProposals('open').catch(() => []),
        ]);
        state.areas = areas;
        const chosen = areas.find((a) => a.id === state.selected) ?? areas[0] ?? null;
        state.selected = chosen?.id ?? null;
        q('.area-list').replaceChildren(...areas.map((a) => areaRow(a, pick, state.selected)));
        await showGrants(chosen);
        q('.area-proposals').replaceChildren(...proposals.map((p) => proposalRow(p, acts)));
        return { areas, proposals };
    }

    wire(q, state, { refresh, fail, say });
    refresh();
    return { refresh, state, pick, acts, say };
}

// The two owner-only controls: hand someone a right, and say how many
// approvals a merge wants. Both are refused by the database, not by this file.
function wire(q, state, { refresh, fail, say }) {
    const chosen = () => state.areas.find((a) => a.id === state.selected);
    q('.area-give').onclick = async () => {
        const area = chosen();
        if (!area) return;
        try {
            await grant(area.id, q('.area-email').value.trim(), q('.area-right').value);
            q('.area-email').value = '';
            say('granted');
            await refresh();
        } catch (err) { fail(err); }
    };
    q('.area-approvals').onchange = async (e) => {
        const area = chosen();
        if (!area) return;
        try {
            area.rules = await setRequiredApprovals(area.id, Number(e.target.value));
            say('rules saved');
            await refresh();
        } catch (err) { fail(err); }
    };
}
