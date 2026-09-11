// adminui.js — the Admin panel: what land, features and products may say about
// themselves.
//
// Every kind and every property on this page is a row in `kind` and `property`
// (db/0040_properties.sql). Nothing here is a list in code: the forms in this
// tool, the layer forms QGIS shows, and the rules the compiler matches on all
// read the same rows, so adding `leaf_type` here is adding it everywhere.
//
// Writing takes an admin — the RPCs say so and the panel does not pretend
// otherwise (Invariant 6).

import * as api from './api.js';

const TYPES = ['text', 'number', 'boolean', 'choice'];
const GEOMETRIES = ['', 'polygon', 'line', 'point'];

const HTML = `
<div class="row">
  <select class="ad-kind"></select>
  <button type="button" class="ad-newkind">New kind</button>
</div>
<ul class="ad-props"></ul>
<div class="ad-add">
  <label>New property</label>
  <div class="row">
    <input class="ad-name" type="text" placeholder="leaf_type" autocomplete="off">
    <select class="ad-type"></select>
  </div>
  <input class="ad-choices" type="text" placeholder="broadleaved, needleleaved" autocomplete="off">
  <div class="row">
    <label class="ad-req"><input class="ad-required" type="checkbox"> required</label>
    <button type="button" class="ad-save primary">Add</button>
  </div>
</div>
<p class="ad-status status"></p>`;

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
    return node;
};

const describe = (p) => [
    p.type,
    p.required ? 'required' : null,
    p.choices?.length ? p.choices.join(' · ') : null,
].filter(Boolean).join(' — ');

function propRow(p, onDrop) {
    const drop = el('button', { type: 'button', textContent: 'remove' });
    drop.onclick = () => onDrop(p);
    return el('li', { className: 'ad-prop' },
        el('div', {}, el('b', { textContent: p.label || p.name }),
            el('span', { className: 'muted mono', textContent: ` ${p.name}` })),
        el('div', { className: 'muted', textContent: describe(p) }),
        drop);
}

export function mountAdmin(host, { onChange = () => {} } = {}) {
    const box = el('div');
    box.innerHTML = HTML;
    host.append(box);
    const q = (sel) => box.querySelector(sel);
    const say = (msg, bad = false) => {
        q('.ad-status').textContent = msg;
        q('.ad-status').dataset.bad = bad ? '1' : '';
    };
    q('.ad-type').replaceChildren(...TYPES.map((t) => new Option(t, t)));

    let vocab = [];

    function draw() {
        const chosen = vocab.find((k) => k.name === q('.ad-kind').value) ?? vocab[0];
        q('.ad-kind').replaceChildren(...vocab.map(
            (k) => new Option(`${k.label || k.name} (${k.name})`, k.name)));
        if (chosen) q('.ad-kind').value = chosen.name;
        q('.ad-props').replaceChildren(...(chosen?.properties ?? []).map(
            (p) => propRow(p, drop)));
        if (chosen && !chosen.properties.length) {
            q('.ad-props').append(el('li', { className: 'muted',
                textContent: 'nothing defined yet — anything may still be written' }));
        }
    }

    async function refresh() {
        vocab = await api.rpc('vocabulary').catch(() => []);
        draw();
        return vocab;
    }

    const save = () => addProperty(q, say, refresh, onChange);
    const drop = (p) => dropProperty(q, say, refresh, onChange, p);
    const newKind = () => addKind(q, say, refresh, draw, onChange);

    q('.ad-kind').onchange = draw;
    q('.ad-save').onclick = save;
    q('.ad-newkind').onclick = newKind;
    q('.ad-type').onchange = () => {
        q('.ad-choices').hidden = q('.ad-type').value !== 'choice';
    };
    q('.ad-choices').hidden = true;

    refresh();
    return { refresh, save, drop, vocabulary: () => vocab };
}

async function addProperty(q, say, refresh, onChange) {
    const name = q('.ad-name').value.trim();
    if (!name) { say('give the property a name', true); return; }
    const type = q('.ad-type').value;
    const choices = q('.ad-choices').value.split(',').map((c) => c.trim()).filter(Boolean);
    try {
        await api.rpc('put_property', {
            kind: q('.ad-kind').value, name, type,
            choices: type === 'choice' ? choices : [],
            required: q('.ad-required').checked,
        });
        q('.ad-name').value = '';
        q('.ad-choices').value = '';
        q('.ad-required').checked = false;
        say(`${name} is part of the world's vocabulary now`);
        await refresh();
        onChange();
    } catch (err) {
        say(String(err.body?.message ?? err.message ?? err), true);
    }
}

async function dropProperty(q, say, refresh, onChange, p) {
    try {
        await api.rpc('drop_property', { kind: q('.ad-kind').value, name: p.name });
        say(`${p.name} removed \u2014 what is already written keeps it`);
        await refresh();
        onChange();
    } catch (err) {
        say(String(err.body?.message ?? err.message ?? err), true);
    }
}

// A kind is a thing the world can hold: a wood, a wall, a kiosk. What people
// draw for it decides which QGIS layer it becomes (T2).
async function addKind(q, say, refresh, draw, onChange) {
    const name = (globalThis.prompt?.('What is this kind called? (one word)') ?? '').trim();
    if (!name) return;
    const geometry = (globalThis.prompt?.(
        `What do people draw for a ${name}? ${GEOMETRIES.filter(Boolean).join(' / ')}`)
        ?? '').trim();
    try {
        await api.rpc('put_kind', { name, geometry: geometry || null });
        await refresh();
        q('.ad-kind').value = name.toLowerCase();
        draw();
        say(`${name} is a thing the world can hold`);
        onChange();
    } catch (err) {
        say(String(err.body?.message ?? err.message ?? err), true);
    }
}
