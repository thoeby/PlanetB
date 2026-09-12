// rulesui.js — what a drawn thing becomes.
//
// The same idea as QGIS's rule-based symbology, and the same order: first match
// wins. A rule is a filter over a feature's own properties and the style it
// produces; nothing about a species, a roof or a column name lives in the
// compiler, it all lives in these rows (db/0036_rules.sql).
//
// This was a page of its own. TASKS-usable T9: it is a part of the Admin panel,
// because a rule is the other half of the vocabulary above it — properties say
// what a thing may carry, rules say what the compiler makes of it.
//
// Saving a rule dirties every tile, because a rule is global.

import * as api from './api.js';

const OPS = ['eq', 'ne', 'in', 'has', 'lt', 'lte', 'gt', 'gte', 'exists', 'missing'];
const NO_VALUE = ['exists', 'missing'];

// Design 3j, right half: Rules — what a drawn thing becomes when a tile is
// compiled. Read as: a forest whose species is birch becomes tapered trunks
// 10-18 m high.
const HTML = `
<div class="section">
  <div class="spread">
    <span class="label">Rules · what a drawn thing becomes</span>
    <button type="button" class="ru-add">New rule</button>
  </div>
  <div class="note">The first rule whose conditions all hold decides what the
    compiler builds. A rule with no conditions catches everything the others
    left.</div>
  <ul class="ru-list rows"></ul>
</div>
<div class="ru-editor" hidden>
  <label>Name</label>
  <input class="ru-name" placeholder="spruce">
  <label>Applies to</label>
  <select class="ru-kind"></select>
  <div class="row">
    <div><label>Order</label><input class="ru-order" type="number" value="100"></div>
    <label class="ru-enabled-box"><input type="checkbox" class="ru-enabled" checked>
      in use</label>
  </div>
  <label>When — all of these are true</label>
  <div class="ru-conds"></div>
  <button type="button" class="ru-add-cond">Add condition</button>
  <p class="muted">No conditions at all: the rule everything else falls into.</p>
  <label>Build — what it produces</label>
  <div class="ru-styles"></div>
  <button type="button" class="ru-add-style">Add property</button>
  <p class="muted">A value may be a number, a word, a list like [12, 22], or
    {"prop": "height", "else": 6} to read it off the thing itself.</p>
  <div class="row">
    <button type="button" class="ru-save primary">Save rule</button>
    <button type="button" class="ru-cancel">Cancel</button>
    <button type="button" class="ru-remove" hidden>Delete</button>
  </div>
</div>
<p class="ru-status status"></p>`;

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
    return node;
};

const short = (value) => {
    const text = JSON.stringify(value);
    return text.length > 40 ? `${text.slice(0, 37)}…` : text;
};

const summarise = (rule) => [
    (rule.filter ?? []).length
        ? rule.filter.map((c) => `${c.prop} ${c.op ?? 'eq'} ${short(c.value)}`).join(', ')
        : 'anything else',
    Object.entries(rule.style ?? {}).map(([k, v]) => `${k}=${short(v)}`).join(', '),
].join(' → ');

// Typed as JSON when it parses as JSON, as a plain word when it does not:
// nobody should have to put quotes around gable.
const parse = (text) => {
    const raw = text.trim();
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch { return raw; }
};

function ruleRow(rule, onEdit) {
    const b = el('button', { type: 'button',
        textContent: `${rule.name}${rule.enabled === false ? ' · off' : ''}` });
    b.onclick = () => onEdit(rule);
    return el('li', { className: 'ru-rule' }, b,
        el('div', { className: 'muted', textContent: `${rule.kind}: ${summarise(rule)}` }));
}

function condRow(cond = {}) {
    const prop = el('input', { className: 'prop', placeholder: 'property',
        value: cond.prop ?? '' });
    const op = el('select', { className: 'op' });
    for (const name of OPS) op.append(new Option(name, name));
    op.value = cond.op ?? 'eq';
    const val = el('input', { className: 'val', placeholder: 'value, or ["a","b"]',
        value: cond.value === undefined ? '' : JSON.stringify(cond.value) });
    const drop = el('button', { type: 'button', textContent: '×' });
    const row = el('div', { className: 'ru-row' }, prop, op, val, drop);
    drop.onclick = () => row.remove();
    return row;
}

function styleRow(key = '', value = '') {
    const name = el('input', { className: 'prop', placeholder: 'property', value: key });
    const val = el('input', { className: 'val', placeholder: '12, "gable", [12, 22]',
        value: value === '' ? '' : JSON.stringify(value) });
    const drop = el('button', { type: 'button', textContent: '×' });
    const row = el('div', { className: 'ru-row' }, name, val, drop);
    drop.onclick = () => row.remove();
    return row;
}

// What the form says, as a build_rule row.
function collect(q) {
    const filter = [...q('.ru-conds').querySelectorAll('.ru-row')].map((row) => {
        const op = row.querySelector('.op').value;
        const cond = { prop: row.querySelector('.prop').value.trim(), op };
        if (!NO_VALUE.includes(op)) cond.value = parse(row.querySelector('.val').value);
        return cond;
    }).filter((cond) => cond.prop);
    const style = {};
    for (const row of q('.ru-styles').querySelectorAll('.ru-row')) {
        const key = row.querySelector('.prop').value.trim();
        const value = parse(row.querySelector('.val').value);
        if (key && value !== undefined) style[key] = value;
    }
    return {
        name: q('.ru-name').value.trim() || 'unnamed',
        kind: q('.ru-kind').value,
        ordering: Number(q('.ru-order').value) || 100,
        enabled: q('.ru-enabled').checked,
        filter,
        style,
    };
}

function fill(q, rule) {
    q('.ru-editor').hidden = false;
    q('.ru-name').value = rule?.name ?? '';
    if (rule?.kind) q('.ru-kind').value = rule.kind;
    q('.ru-order').value = String(rule?.ordering ?? 100);
    q('.ru-enabled').checked = rule?.enabled !== false;
    q('.ru-conds').replaceChildren(...(rule?.filter ?? []).map(condRow));
    q('.ru-styles').replaceChildren(
        ...Object.entries(rule?.style ?? {}).map(([k, v]) => styleRow(k, v)));
    q('.ru-remove').hidden = !rule;
}

// The rules as they stand, and the kinds a rule may be about.
async function list(q, onEdit) {
    const rules = await api.selectAll('build_rule',
        { order: 'kind.asc,ordering.asc,id.asc' }).catch(() => []);
    q('.ru-list').replaceChildren(...rules.map((r) => ruleRow(r, onEdit)));
    if (!rules.length) {
        q('.ru-list').append(el('li', { className: 'muted',
            textContent: 'no rules yet — what is drawn becomes nothing' }));
    }
    q('.ru-kind').replaceChildren(...(await kinds()).map((k) => new Option(k, k)));
    return rules;
}

// Every kind the world has, plus the one that matches whatever is left. The
// list is the world's own vocabulary (T3), never a list written down here.
async function kinds() {
    const rows = await api.rpc('vocabulary', { applies_to: 'feature' }).catch(() => []);
    return [...(rows ?? []).map((k) => k.name), '*'];
}

export function mountRules(host) {
    const box = el('div');
    box.innerHTML = HTML;
    host.append(box);
    const q = (sel) => box.querySelector(sel);
    const say = (msg, bad = false) => {
        q('.ru-status').textContent = msg;
        q('.ru-status').dataset.bad = bad ? '1' : '';
    };
    let editing = null;

    const close = () => { q('.ru-editor').hidden = true; editing = null; };
    const open = (rule) => { editing = rule; fill(q, rule); };

    const refresh = () => list(q, open);

    async function save() {
        const body = collect(q);
        q('.ru-save').disabled = true;
        try {
            await (editing
                ? api.request(`/build_rule?id=eq.${editing.id}`, { method: 'PATCH', body })
                : api.request('/build_rule', { method: 'POST', body }));
            close();
            await refresh();
            say('saved — every tile is dirty now, and has to be rendered again');
        } catch (err) {
            say(`${err.body?.message ?? err.message} (only an admin may change rules)`, true);
        } finally {
            q('.ru-save').disabled = false;
        }
    }

    async function remove() {
        if (!editing) return;
        try {
            await api.request(`/build_rule?id=eq.${editing.id}`, { method: 'DELETE' });
            close();
            await refresh();
            say('deleted');
        } catch (err) {
            say(String(err.body?.message ?? err.message ?? err), true);
        }
    }

    q('.ru-add').onclick = () => open(null);
    q('.ru-add-cond').onclick = () => q('.ru-conds').append(condRow());
    q('.ru-add-style').onclick = () => q('.ru-styles').append(styleRow());
    q('.ru-cancel').onclick = close;
    q('.ru-save').onclick = save;
    q('.ru-remove').onclick = remove;

    refresh();
    return { refresh, open, save, close };
}
