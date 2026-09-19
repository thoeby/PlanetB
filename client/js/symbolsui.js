// symbolsui.js — Settings → Symbols: what a drawn thing becomes.
//
// FND.7. This was Rules, and a rule produced a bag of values the compiler knew
// how to read. A symbol produces a stack of layers instead, and the compiler
// stops knowing what a road is. The filter builder and the layer stack are
// client/js/symbolform.js; the sample beside them is client/js/symbolpreview.js,
// compiled in this tab by the code the atom runs.
//
// It decides nothing. Only an operator may save one (db/0161), and saving does
// not change anything anybody has published — the world is built with the
// applied style until somebody applies it again (FND.8).

import * as api from './api.js';
import { el } from './poolui.js';
import { layerWords, layerTrouble } from '../lib/symbols.js';
import { collectLayers, condRow, condsIn, mountLayers } from './symbolform.js';
import { SymbolPreview, sampleFeature } from './symbolpreview.js';

const GEOMETRY = { highway: 'line', railway: 'line', aerialway: 'line',
    waterway: 'line', barrier: 'line', natural_point: 'point' };

const HTML = `
<div class="sy-cols">
  <div class="sy-left">
    <div class="spread">
      <span class="label">Symbols</span>
      <button type="button" class="sy-new">New symbol</button>
    </div>
    <div class="sy-apply-box">
      <p class="muted sy-changed"></p>
      <button type="button" class="sy-apply primary" disabled>Apply to world</button>
      <div class="sy-confirm" hidden>
        <p class="sy-confirm-said"></p>
        <input class="sy-note" placeholder="a note, if you like">
        <div class="row">
          <button type="button" class="sy-really primary">Yes, apply it</button>
          <button type="button" class="sy-not">Cancel</button>
        </div>
      </div>
    </div>
    <div class="note">The first symbol of a kind whose conditions all hold
      decides what the compiler lays down. A symbol with no conditions catches
      everything the ones above it left.</div>
    <ul class="sy-list rows"></ul>
  </div>
  <div class="sy-mid">
    <label>Name<input class="sy-name" placeholder="Kantonsstrasse"></label>
    <div class="row">
      <label>Applies to<select class="sy-kind"></select></label>
      <label>Order<input class="sy-order" type="number" value="100"></label>
      <label class="sy-enabled-box"><input type="checkbox" class="sy-enabled" checked>
        in use</label>
    </div>
    <span class="label">When — all of these are true</span>
    <div class="sy-conds"></div>
    <button type="button" class="sy-add-cond">Add condition</button>
    <div class="sy-layers"></div>
    <div class="row">
      <button type="button" class="sy-save primary">Save symbol</button>
      <button type="button" class="sy-history">History</button>
    </div>
    <p class="sy-status status"></p>
    <ul class="sy-versions rows" hidden></ul>
  </div>
  <div class="sy-right">
    <span class="label">Preview</span>
    <canvas class="sy-preview preview" width="256" height="256"></canvas>
    <div class="note">A sample of this kind on a gentle slope, built by the
      same code the world is built with. Drag to turn it.</div>
    <span class="label">Try values</span>
    <div class="sy-props"></div>
    <button type="button" class="sy-add-prop">Add a property</button>
    <p class="muted sy-said"></p>
  </div>
</div>`;

// One line of the list: the symbol, what it is about, and whether it is on.
function symbolRow(symbol, at, onPick) {
    const b = el('button', { type: 'button', className: 'sy-symbol',
        textContent: symbol.name });
    b.classList.toggle('picked', symbol.id === at);
    b.onclick = () => onPick(symbol);
    const says = (symbol.layers ?? []).map((l) => layerWords(l.layer)).join(' + ')
        || 'nothing';
    return el('li', {}, b, el('span', { className: 'muted',
        textContent: `${symbol.kind} · ${says}${symbol.enabled === false ? ' · off' : ''}` }));
}

// A property to try the symbol with: "highway = secondary", "lit = yes".
function propRow(name = '', value = '', onChange) {
    const key = el('input', { className: 'prop', placeholder: 'property', value: name });
    const val = el('input', { className: 'val', placeholder: 'value', value });
    const drop = el('button', { type: 'button', textContent: '×' });
    const row = el('div', { className: 'sy-prop' }, key, val, drop);
    drop.onclick = () => { row.remove(); onChange(); };
    for (const node of [key, val]) node.addEventListener('change', onChange);
    return row;
}

const propsIn = (host) => Object.fromEntries([...host.querySelectorAll('.sy-prop')]
    .map((row) => [row.querySelector('.prop').value.trim(),
        row.querySelector('.val').value])
    .filter(([k]) => k));

// What the form says right now, as a symbol.
const current = (ui) => ({
    name: ui.q('.sy-name').value.trim() || 'unnamed',
    kind: ui.q('.sy-kind').value,
    ordering: Number(ui.q('.sy-order').value) || 100,
    enabled: ui.q('.sy-enabled').checked,
    filter: condsIn(ui.box, '.sy-cond'),
    layers: collectLayers(ui.box, ui.state),
});

// The sample, built by the same code the world is built with. The symbol's
// own conditions are dropped for the preview: the sample is the thing the
// symbol is about, and the properties beside it are what is being tried.
function paint(ui) {
    const symbol = current(ui);
    const props = propsIn(ui.q('.sy-props'));
    const feature = sampleFeature(symbol.kind, GEOMETRY[symbol.kind] ?? 'area', props);
    try {
        const built = ui.preview.draw(ui.q('.sy-preview'), { ...symbol, filter: [] },
            feature, {
                asset: (san) => want(ui, san)?.bytes ?? null,
                product: (san) => want(ui, san)?.json ?? null,
            });
        ui.q('.sy-said').textContent = `${built.meshes.length} meshes`
            + (built.trees ? ` \u00b7 ${built.trees} scattered` : '')
            + (built.flags.length ? ` \u00b7 ${built.flags.length} flagged` : '');
    } catch (err) {
        ui.q('.sy-said').textContent = String(err.message ?? err);
    }
}

// FND.12: the ground cover is one more thing that is saved and not applied,
// and it is not a symbol, so it is not counted as one.
function saidOf(rows) {
    const cover = (rows ?? []).some((c) => c.kind === 'cover');
    const n = (rows ?? []).length - (cover ? 1 : 0);
    const symbols = n ? `${n} symbol${n === 1 ? '' : 's'}` : '';
    return [symbols, cover ? 'the ground cover' : ''].filter(Boolean).join(' and ');
}

// What is saved but not built with, and how much of the world it would
// rebuild. The numbers are the database's (db/0162), not a count made here.
async function changes(ui) {
    const rows = await api.rpc('style_changes').catch(() => []);
    ui.state.changed = rows ?? [];
    const tiles = (rows ?? []).reduce((n, c) => Math.max(n, c.tiles ?? 0), 0);
    ui.q('.sy-changed').textContent = rows?.length
        ? `${saidOf(rows)} changed since the last apply \u00b7 ${tiles} published`
            + ` tile${tiles === 1 ? '' : 's'} would be rebuilt`
        : 'the world is built with every symbol as it stands';
    ui.q('.sy-apply').disabled = !rows?.length;
    return rows;
}

// Applying is one transaction in the database and nothing here (Invariant 4):
// it pins a style, marks the tiles it changed, and opens their jobs at the
// back of the pool.
async function apply(ui) {
    const note = ui.q('.sy-note').value.trim();
    try {
        const got = await api.rpc('apply_styles', { note: note || null });
        ui.q('.sy-confirm').hidden = true;
        ui.say(`applied \u00b7 ${got.symbols} symbol(s) \u00b7 ${got.tiles}`
            + ' tile(s) to render again');
        await changes(ui);
        return got;
    } catch (err) {
        ui.say(String(err.body?.message ?? err.message ?? err), true);
        return null;
    }
}

async function list(ui) {
    const rows = await api.selectAll('symbol',
        { order: 'kind.asc,ordering.asc,id.asc' }).catch(() => []);
    ui.state.rows = rows;
    ui.q('.sy-list').replaceChildren(...rows.map((s) => symbolRow(s, ui.state.at,
        (symbol) => fill(ui, symbol))));
    if (!rows.length) {
        ui.q('.sy-list').append(el('li', { className: 'muted',
            textContent: 'no symbols yet — what is drawn becomes nothing' }));
    }
    await changes(ui);
    return rows;
}

function fill(ui, symbol) {
    ui.state.at = symbol?.id ?? null;
    ui.state.layers = JSON.parse(JSON.stringify(symbol?.layers ?? []));
    ui.state.layerAt = 0;
    ui.q('.sy-name').value = symbol?.name ?? '';
    if (symbol?.kind) ui.q('.sy-kind').value = symbol.kind;
    ui.q('.sy-order').value = String(symbol?.ordering ?? 100);
    ui.q('.sy-enabled').checked = symbol?.enabled !== false;
    ui.q('.sy-conds').replaceChildren(...(symbol?.filter ?? []).map((c) => condRow(c)));
    ui.q('.sy-versions').hidden = true;
    ui.layers.redraw();
    list(ui);
}

async function save(ui) {
    const symbol = current(ui);
    const trouble = layerTrouble(symbol.layers, (san) => ui.state.types.get(san) ?? null);
    if (trouble) { ui.say(trouble, true); return null; }
    ui.q('.sy-save').disabled = true;
    try {
        const got = await api.rpc('save_symbol', { p_id: ui.state.at, p_name: symbol.name,
            p_kind: symbol.kind, p_ordering: symbol.ordering, p_filter: symbol.filter,
            p_layers: symbol.layers, p_enabled: symbol.enabled });
        ui.state.at = got.id;
        ui.say(`saved as version ${got.version} \u2014 not in the world yet`);
        await list(ui);
        return got;
    } catch (err) {
        ui.say(String(err.body?.message ?? err.message ?? err), true);
        return null;
    } finally {
        ui.q('.sy-save').disabled = false;
    }
}

// The versions this symbol has been saved as; opening one fills the form with
// it, and saving makes it the current one.
async function history(ui) {
    const rows = ui.q('.sy-versions');
    rows.hidden = !rows.hidden;
    if (rows.hidden || !ui.state.at) return;
    const got = await api.selectAll('symbol_version',
        { symbol_id: `eq.${ui.state.at}`, order: 'version.desc' }).catch(() => []);
    rows.replaceChildren(...got.map((v) => versionRow(ui, v)));
}

export function mountSymbols(host) {
    const box = el('div');
    box.innerHTML = HTML;
    host.append(box);
    const q = (sel) => box.querySelector(sel);
    const ui = { box, q, preview: new SymbolPreview(),
        state: { at: null, layerAt: 0, layers: [], rows: [], changed: [],
            types: new Map(), files: new Map() },
        say: (msg, bad = false) => {
            q('.sy-status').textContent = msg;
            q('.sy-status').dataset.bad = bad ? '1' : '';
        } };
    ui.layers = mountLayers(q('.sy-layers'), ui.state, () => paint(ui));
    wire(ui);
    kinds().then(async (names) => {
        q('.sy-kind').replaceChildren(...names.map((k) => new Option(k, k)));
        await products(ui);
        fill(ui, (await list(ui))[0] ?? null);
    });
    return { ui, list: () => list(ui), fill: (s) => fill(ui, s), save: () => save(ui),
        current: () => current(ui), paint: () => paint(ui),
        changes: () => changes(ui), apply: () => apply(ui) };
}

// What every product in the catalog is, and the file behind it: a layer may
// only name one of the right type (client/lib/symbols.js), and the preview
// needs the bytes to lay a segment down.
async function products(ui) {
    const rows = await api.selectAll('asset', { select: 'san,type,sha256' }).catch(() => []);
    for (const a of rows) ui.state.types.set(a.san, a.type);
    ui.state.sha = new Map(rows.map((a) => [a.san, [a.sha256, a.type]]));
}

const EXT = { model: 'glb', segment: 'glb', material: 'png',
    profile: 'json', collection: 'json' };

// The file behind a product, fetched the first time a layer names it and
// drawn the moment it lands — the preview says what it can until then.
function want(ui, san) {
    if (!san || !ui.state.sha.has(san)) return null;
    if (ui.state.files.has(san)) return ui.state.files.get(san);
    ui.state.files.set(san, null);
    const [sha, type] = ui.state.sha.get(san);
    fetch(`${api.endpoints().files}/assets/${sha}.${EXT[type] ?? 'glb'}`)
        .then((res) => (res.ok ? res.arrayBuffer() : null))
        .then((buf) => {
            if (!buf) return;
            const bytes = new Uint8Array(buf);
            ui.state.files.set(san, { bytes, type,
                json: EXT[type] === 'json'
                    ? JSON.parse(new TextDecoder().decode(bytes)) : null });
            paint(ui);
        })
        .catch(() => {});
    return null;
}

function versionRow(ui, v) {
    const was = ui.state.rows.find((s) => s.id === ui.state.at);
    const open = el('button', { type: 'button', className: 'sy-version',
        textContent: `version ${v.version}` });
    open.onclick = () => fill(ui, { id: ui.state.at, name: v.name,
        kind: was?.kind ?? '*', filter: v.filter, layers: v.layers,
        ordering: was?.ordering ?? 100, enabled: true });
    return el('li', {}, open, el('span', { className: 'muted',
        textContent: new Date(v.saved_at).toLocaleString() }));
}

// Every kind the world has, plus the one that matches whatever is left. The
// list is the world's own vocabulary, never a list written down here.
async function kinds() {
    const rows = await api.rpc('vocabulary', { applies_to: 'feature' }).catch(() => []);
    return [...(rows ?? []).map((k) => k.name), '*'];
}

function wire(ui) {
    const { box, q } = ui;
    const again = () => paint(ui);
    q('.sy-new').onclick = () => fill(ui, null);
    q('.sy-add-cond').onclick = () => { q('.sy-conds').append(condRow()); again(); };
    q('.sy-save').onclick = () => save(ui);
    q('.sy-apply').onclick = () => {
        const tiles = ui.state.changed.reduce((n, c) => Math.max(n, c.tiles ?? 0), 0);
        q('.sy-confirm-said').textContent =
            `${saidOf(ui.state.changed)} would go into the world, and`
            + ` ${tiles} published tile(s) would be rendered again.`;
        q('.sy-confirm').hidden = false;
    };
    q('.sy-not').onclick = () => { q('.sy-confirm').hidden = true; };
    q('.sy-really').onclick = () => apply(ui);
    q('.sy-history').onclick = () => history(ui);
    q('.sy-add-prop').onclick = () => {
        q('.sy-props').append(propRow('', '', again));
        again();
    };
    for (const sel of ['.sy-name', '.sy-kind', '.sy-order', '.sy-enabled']) {
        q(sel).addEventListener('change', again);
    }
    orbitable(q('.sy-preview'), ui, again);
    box.addEventListener('gone', again);
    box.addEventListener('change', (e) => {
        if (e.target.closest('.sy-cond, .sy-prop')) again();
    });
}

// Dragging on the picture turns it, the way every 3D view in this world turns.
function orbitable(canvas, ui, again) {
    let from = null;
    canvas.addEventListener('pointerdown', (e) => { from = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointermove', (e) => {
        if (!from) return;
        ui.preview.orbit(e.clientX - from[0], e.clientY - from[1]);
        from = [e.clientX, e.clientY];
        again();
    });
    for (const name of ['pointerup', 'pointerleave']) {
        canvas.addEventListener(name, () => { from = null; });
    }
}
