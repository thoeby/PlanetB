// adminui.js — Settings · Vocabulary: what land, features and products may say
// about themselves.
//
// Every kind and every property on this page is a row in `kind` and `property`
// (db/0040_properties.sql). Nothing here is a list in code: the forms in this
// tool, the layer forms QGIS shows, and the symbols the compiler matches on all
// read the same rows, so adding `leaf_type` here is adding it everywhere.
//
// Writing takes an admin — the RPCs say so and the panel does not pretend
// otherwise (Invariant 6). The nodes are client/js/vocabui.js; this asks the
// world and decides what to do with the answers.

import * as api from './api.js';
import { APPLIES, GEOMETRIES, HTML, TYPES, drawKinds, options, propRow, whatWord }
    from './vocabui.js';

// How many things in the world are of each kind. `feature_matches` (db/0175)
// with no conditions is every feature of a kind, which is the one number that
// says whether a kind is used at all — the panel could not say it, and a
// dropdown of thirty names said nothing about any of them.
async function countKinds(vocab) {
    const counts = new Map();
    const drawn = vocab.filter((k) => (k.applies_to ?? 'feature') === 'feature');
    await Promise.all(drawn.map(async (k) => {
        const n = await api.rpc('feature_matches', { p_kind: k.name, p_filter: [] })
            .catch(() => null);
        if (n !== null) counts.set(k.name, `${Number(n).toLocaleString()} drawn`);
    }));
    return counts;
}

// The kind in hand, in its own fields. `put_kind` is an upsert, so this is how
// a kind is renamed for people and reordered — both have been possible since
// db/0040 and neither was on the page.
function fillKind(ui, kind) {
    ui.state.at = kind?.name ?? null;
    ui.q('.vo-label').value = kind?.label ?? '';
    ui.q('.vo-name').value = kind?.name ?? '';
    ui.q('.vo-geom').value = kind?.geometry ?? '';
    ui.q('.vo-order').value = String(kind?.ordering ?? 100);
    ui.q('.vo-of').textContent = kind
        ? `${whatWord(kind.applies_to ?? 'feature')} · ${
            (kind.properties ?? []).length} propert${
            (kind.properties ?? []).length === 1 ? 'y' : 'ies'}`
        : 'pick a kind on the left';
    ui.q('.vo-props').replaceChildren(...(kind?.properties ?? []).map(
        (p) => propRow(p, { onSave: (name, fields) => saveProp(ui, name, fields),
            onDrop: (dropped) => dropProperty(ui, dropped) })));
    if (kind && !kind.properties.length) {
        ui.q('.vo-props').append(Object.assign(document.createElement('li'),
            { className: 'muted',
                textContent: 'nothing defined yet — anything may still be written' }));
    }
    ui.q('.vo-mid').dataset.empty = kind ? '' : '1';
}

export function mountAdmin(host, { onChange = () => {}, openPart = null } = {}) {
    const box = Object.assign(document.createElement('div'), { innerHTML: HTML });
    host.append(box);
    const q = (sel) => box.querySelector(sel);
    const ui = { box, q, onChange, state: { at: null, vocab: [], counts: new Map() },
        say: (msg, bad = false) => {
            q('.ad-status').textContent = msg;
            q('.ad-status').dataset.bad = bad ? '1' : '';
        } };
    options(q('.ad-type'), TYPES);
    options(q('.vo-geom'), GEOMETRIES, 'not drawn');
    options(q('.vo-new-geom'), GEOMETRIES, 'not drawn');
    options(q('.vo-new-applies'), APPLIES);
    ui.refresh = () => refresh(ui);
    wire(ui, openPart);
    ui.refresh();
    return { refresh: () => refresh(ui), save: () => addProperty(ui),
        pick: (name) => pick(ui, name), vocabulary: () => ui.state.vocab };
}

async function refresh(ui) {
    ui.state.vocab = await api.rpc('vocabulary').catch(() => []);
    ui.state.counts = await countKinds(ui.state.vocab);
    draw(ui);
    return ui.state.vocab;
}

function draw(ui) {
    const at = ui.state.vocab.find((k) => k.name === ui.state.at) ?? ui.state.vocab[0];
    drawKinds(ui.q('.vo-kinds'), ui.state.vocab, {
        at: at?.name ?? null, counts: ui.state.counts,
        onPick: (k) => { fillKind(ui, k); draw(ui); },
    });
    fillKind(ui, at ?? null);
}

const pick = (ui, name) => {
    const k = ui.state.vocab.find((one) => one.name === name);
    if (k) { fillKind(ui, k); draw(ui); }
    return k ?? null;
};

// Every write goes through one place, because every one of them is the same
// three lines: ask, say what happened, read the world again.
async function wrote(ui, rpc, args, said) {
    try {
        await api.rpc(rpc, args);
    } catch (err) {
        ui.say(String(err.body?.message ?? err.message ?? err), true);
        return false;
    }
    ui.say(said);
    await refresh(ui);
    ui.onChange();
    return true;
}

const kindOf = (ui) => ui.state.vocab.find((k) => k.name === ui.state.at) ?? null;

async function saveKind(ui) {
    const kind = kindOf(ui);
    if (!kind) { ui.say('pick a kind first', true); return false; }
    return wrote(ui, 'put_kind', {
        name: kind.name, applies_to: kind.applies_to ?? 'feature',
        geometry: ui.q('.vo-geom').value || null,
        label: ui.q('.vo-label').value.trim(),
        ordering: Number(ui.q('.vo-order').value) || 100,
    }, `${kind.name} saved`);
}

async function saveProp(ui, name, fields) {
    if (!ui.state.at) return false;
    return wrote(ui, 'put_property', { kind: ui.state.at, name, ...fields },
        `${name} saved`);
}

async function addProperty(ui) {
    const name = ui.q('.ad-name').value.trim();
    if (!name) { ui.say('give the property a name', true); return false; }
    if (!ui.state.at) { ui.say('pick a kind first', true); return false; }
    const type = ui.q('.ad-type').value;
    const choices = ui.q('.ad-choices').value.split(',').map((c) => c.trim())
        .filter(Boolean);
    const done = await wrote(ui, 'put_property', {
        kind: ui.state.at, name, type, label: ui.q('.vo-add-label').value.trim(),
        choices: type === 'choice' ? choices : [],
        required: ui.q('.ad-required').checked,
    }, `${name} is part of the world's vocabulary now`);
    if (!done) return false;
    for (const sel of ['.ad-name', '.ad-choices', '.vo-add-label']) ui.q(sel).value = '';
    ui.q('.ad-required').checked = false;
    return true;
}

const dropProperty = (ui, p) => wrote(ui, 'drop_property',
    { kind: ui.state.at, name: p.name },
    `${p.name} removed — what is already written keeps it`);

// A kind is a thing the world can hold: a wood, a wall, a kiosk. It was asked
// for with two browser prompts in a row, which cannot be corrected, cannot be
// read back, and look like nothing else in this world.
async function addKind(ui) {
    const name = ui.q('.vo-new-name').value.trim().toLowerCase();
    if (!name) { ui.say('give the kind a name', true); return false; }
    const done = await wrote(ui, 'put_kind', {
        name, applies_to: ui.q('.vo-new-applies').value,
        geometry: ui.q('.vo-new-geom').value || null,
        label: ui.q('.vo-new-label').value.trim(),
    }, `${name} is a thing the world can hold`);
    if (!done) return false;
    ui.q('.vo-new').hidden = true;
    for (const sel of ['.vo-new-name', '.vo-new-label']) ui.q(sel).value = '';
    pick(ui, name);
    return true;
}

function wire(ui, openPart) {
    const q = ui.q;
    q('.ad-to-symbols').onclick = () => openPart?.('Symbols');
    q('.ad-newkind').onclick = () => {
        q('.vo-new').hidden = !q('.vo-new').hidden;
        if (!q('.vo-new').hidden) q('.vo-new-name').focus();
    };
    q('.vo-new-not').onclick = () => { q('.vo-new').hidden = true; };
    q('.vo-new').onsubmit = (e) => { e.preventDefault(); addKind(ui); };
    q('.vo-add').onsubmit = (e) => { e.preventDefault(); addProperty(ui); };
    q('.vo-save-kind').onclick = () => saveKind(ui);
    q('.ad-type').onchange = () => {
        q('.ad-choices').hidden = q('.ad-type').value !== 'choice';
    };
    q('.ad-choices').hidden = true;
}
