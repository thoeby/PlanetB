// symbolsui.js — Settings → Symbols: what a drawn thing becomes.
//
// FND.7. This was Rules, and a rule produced a bag of values the compiler knew
// how to read. A symbol produces a stack of layers instead, and the compiler
// stops knowing what a road is.
//
// Four columns of nodes, each in its own file: the symbols on the left
// (client/js/symbollist.js), what this one is and when it applies here, what
// it lays down (client/js/symbollayers.js), and the sample beside the values
// it is tried with and every version it has been saved as
// (client/js/symbolpreview.js, client/js/symboltry.js).
//
// It decides nothing. Only an operator may save one (db/0161), and saving does
// not change anything anybody has published — the world is built with the
// applied style until somebody applies it again (FND.8).

import * as api from './api.js';
import { el } from './poolui.js';
import { layerTrouble } from '../lib/symbols.js';
import { collectLayers, mountLayers } from './symbollayers.js';
import { condRow, condsIn } from './symbolform.js';
import { mountSymbolList } from './symbollist.js';
import { mountHistory, mountTry } from './symboltry.js';
import { SymbolPreview, sampleFeature } from './symbolpreview.js';
import { applyBox, headRow, HTML } from './symbolhtml.js';

const GEOMETRY = { highway: 'line', railway: 'line', aerialway: 'line',
    waterway: 'line', barrier: 'line', natural_point: 'point' };

// What the form says right now, as a symbol.
const current = (ui) => ({
    id: ui.state.at,
    name: ui.q('.sy-name').value.trim() || 'unnamed',
    kind: ui.q('.sy-kind').value,
    ordering: Number(ui.q('.sy-order').value) || 100,
    enabled: ui.state.enabled !== false,
    filter: condsIn(ui.box, '.sy-cond'),
    layers: collectLayers(ui.box, ui.state),
});

// The sample, built by the same code the world is built with. The symbol's own
// conditions are dropped for the preview: the sample is the thing the symbol
// is about, and the values beside it are what is being tried.
function paint(ui) {
    const symbol = current(ui);
    const feature = sampleFeature(symbol.kind, GEOMETRY[symbol.kind] ?? 'area',
        ui.tries.values());
    try {
        const built = ui.preview.draw(ui.q('.sy-preview'), { ...symbol, filter: [] },
            feature, {
                asset: (san) => want(ui, san)?.bytes ?? null,
                product: (san) => want(ui, san)?.json ?? null,
            });
        ui.q('.sy-said').textContent = `${built.meshes.length} meshes`
            + (built.trees ? ` · ${built.trees} scattered` : '')
            + (built.flags.length ? ` · ${built.flags.length} flagged` : '');
    } catch (err) {
        ui.q('.sy-said').textContent = String(err.message ?? err);
    }
}

// How many features in the world this symbol catches as it now stands — not as
// it was last saved (db/0175). A symbol being edited that matches nothing and
// one that matches every road in the valley used to look exactly the same.
async function counted(ui) {
    const symbol = current(ui);
    const key = JSON.stringify([symbol.kind, symbol.filter]);
    if (key === ui.state.countKey) return;
    ui.state.countKey = key;
    const n = await api.rpc('feature_matches',
        { p_kind: symbol.kind, p_filter: symbol.filter }).catch(() => null);
    if (key !== ui.state.countKey) return;      // the form moved on meanwhile
    ui.q('.sy-matches').textContent = n === null ? ''
        : `matches ${Number(n).toLocaleString()} feature${Number(n) === 1 ? '' : 's'}`
          + ' in the world';
}

// Everything that has to be redrawn when the form changes: the sample, the
// count, and the values the sample is tried with.
function again(ui) {
    ui.tries.show(current(ui));
    paint(ui);
    counted(ui);
}

// FND.12: the ground cover is one more thing that is saved and not applied,
// and it is not a symbol, so it is not counted as one.
export function saidOf(rows) {
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
        ? `${saidOf(rows)} changed since the last apply · ${tiles} published`
            + ` tile${tiles === 1 ? '' : 's'} would be rebuilt`
        : 'the world is built with every symbol as it stands';
    ui.q('.sy-changed').dataset.some = rows?.length ? '1' : '';
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
        ui.say(`applied · ${got.symbols} symbol(s) · ${got.tiles}`
            + ' tile(s) to render again');
        await list(ui);
        return got;
    } catch (err) {
        ui.say(String(err.body?.message ?? err.message ?? err), true);
        return null;
    }
}

async function list(ui) {
    const rows = await api.rpc('symbols_now').catch(() => []);
    ui.state.rows = rows ?? [];
    ui.list.draw(ui.state.rows, ui.state.at);
    await changes(ui);
    return ui.state.rows;
}

// Which version of this symbol the world is built with, said beside the name.
function saidVersion(ui, symbol) {
    const row = ui.state.rows.find((s) => s.id === symbol?.id);
    const kind = symbol?.kind ? `kind ${symbol.kind}` : 'a new symbol';
    if (!row) return kind;
    if (!row.applied) return `${kind} · never applied to the world`;
    return `${kind} · version ${row.applied} in the world`
        + (row.applied === row.version ? '' : `, ${row.version} saved`);
}

function fill(ui, symbol) {
    ui.state.at = symbol?.id ?? null;
    ui.state.layers = JSON.parse(JSON.stringify(symbol?.layers ?? []));
    ui.state.layerAt = 0;
    ui.state.enabled = symbol?.enabled !== false;
    ui.q('.sy-name').value = symbol?.name ?? '';
    // A kind the world's vocabulary no longer lists is still this symbol's
    // kind: offering it is the only way the form can say what it is, and
    // dropping it silently would save the symbol as something else.
    if (symbol?.kind) {
        const kinds = ui.q('.sy-kind');
        if (![...kinds.querySelectorAll('option')].some((o) => o.value === symbol.kind)) {
            kinds.append(new Option(symbol.kind, symbol.kind));
        }
        kinds.value = symbol.kind;
    }
    ui.q('.sy-order').value = String(symbol?.ordering ?? 100);
    // What a symbol is about has to be chosen once, when it is new; after
    // that it is a line of text beside the name and the field is out of the
    // way. The order is dragged in the list now, and is here for typing in.
    ui.q('.sy-more').hidden = Boolean(ui.state.at);
    ui.q('.sy-conds').replaceChildren(...(symbol?.filter ?? []).map((c) => condRow(c)));
    ui.q('.sy-of').textContent = saidVersion(ui, symbol);
    ui.q('.sy-save').textContent = ui.state.at ? 'Save as a new version' : 'Save this symbol';
    ui.layers.redraw();
    history(ui);
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
        ui.say(`saved as version ${got.version} — not in the world yet`);
        await list(ui);
        ui.q('.sy-of').textContent = saidVersion(ui, { ...symbol, id: got.id });
        await history(ui);
        return got;
    } catch (err) {
        ui.say(String(err.body?.message ?? err.message ?? err), true);
        return null;
    } finally {
        ui.q('.sy-save').disabled = false;
    }
}

// Every version this symbol has been saved as, who saved it, and which one the
// world is built with (db/0175). Always on screen: it was behind a button.
async function history(ui) {
    if (!ui.state.at) { ui.history.draw([]); return; }
    const got = await api.rpc('symbol_history', { p_symbol: ui.state.at }).catch(() => []);
    ui.history.draw(got ?? []);
}

// One symbol's in-use switch, saved where it is pressed: a list that only
// looks switched until somebody remembers to press Save is a lie.
async function toggle(ui, symbol, on) {
    try {
        await api.rpc('save_symbol', { p_id: symbol.id, p_name: symbol.name,
            p_kind: symbol.kind, p_ordering: symbol.ordering, p_filter: symbol.filter,
            p_layers: symbol.layers, p_enabled: on });
        if (symbol.id === ui.state.at) ui.state.enabled = on;
        ui.say(`${symbol.name} is ${on ? 'in use' : 'off'} — not in the world yet`);
    } catch (err) {
        ui.say(String(err.body?.message ?? err.message ?? err), true);
    }
    await list(ui);
}

// The order the rows were dragged into, as the `ordering` of each. Ten apart,
// so one can be dropped between two without renumbering the rest.
async function reorder(ui, kind, order) {
    for (const [i, id] of order.entries()) {
        const s = ui.state.rows.find((r) => r.id === id);
        if (!s || s.ordering === (i + 1) * 10) continue;
        await api.rpc('save_symbol', { p_id: s.id, p_name: s.name, p_kind: s.kind,
            p_ordering: (i + 1) * 10, p_filter: s.filter, p_layers: s.layers,
            p_enabled: s.enabled }).catch((err) => {
            ui.say(String(err.body?.message ?? err.message ?? err), true);
        });
    }
    ui.say(`${kind} reordered — not in the world yet`);
    if (ui.state.at) {
        const mine = ui.state.rows.find((r) => r.id === ui.state.at);
        if (mine) ui.q('.sy-order').value = String(mine.ordering);
    }
    await list(ui);
}

export function mountSymbols(host) {
    const box = el('div');
    box.innerHTML = HTML;
    host.append(box);
    const q = (sel) => box.querySelector(sel);
    const ui = { box, q, preview: new SymbolPreview(),
        state: { at: null, layerAt: 0, layers: [], rows: [], changed: [], enabled: true,
            countKey: '', types: new Map(), files: new Map() },
        say: (msg, bad = false) => {
            q('.sy-status').textContent = msg;
            q('.sy-status').dataset.bad = bad ? '1' : '';
        } };
    ui.list = mountSymbolList(q('.sy-left'), {
        onPick: (s) => fill(ui, s),
        onToggle: (s, on) => toggle(ui, s, on),
        onMove: (kind, order) => reorder(ui, kind, order),
        onNew: () => fill(ui, null),
    });
    ui.tries = mountTry(q('.sy-try-box'), () => paint(ui));
    ui.history = mountHistory(q('.sy-history'), (v) => fill(ui,
        { ...(ui.state.rows.find((s) => s.id === ui.state.at) ?? {}),
            id: ui.state.at, name: v.name, filter: v.filter, layers: v.layers }));
    ui.layers = mountLayers(q('.sy-layers'), ui.state, () => again(ui),
        (san) => ui.state.types.get(san) ?? null);
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

// Every kind the world has, plus the one that matches whatever is left. The
// list is the world's own vocabulary, never a list written down here.
async function kinds() {
    const rows = await api.rpc('vocabulary', { applies_to: 'feature' }).catch(() => []);
    return [...(rows ?? []).map((k) => k.name), '*'];
}

function wire(ui) {
    const { box, q } = ui;
    q('.sy-add-cond').onclick = () => { q('.sy-conds').append(condRow()); again(ui); };
    q('.sy-save').onclick = () => save(ui);
    applyBox(ui, { onApply: () => apply(ui), saidOf });
    for (const sel of ['.sy-name', '.sy-kind', '.sy-order']) {
        q(sel).addEventListener('change', () => again(ui));
    }
    headRow(ui, () => again(ui));
    orbitable(q('.sy-preview'), ui, () => paint(ui));
    box.addEventListener('gone', () => again(ui));
    box.addEventListener('change', (e) => {
        if (e.target.closest('.sy-cond')) again(ui);
    });
}

// Dragging on the picture turns it, the way every 3D view in this world turns.
function orbitable(canvas, ui, onTurn) {
    let from = null;
    canvas.addEventListener('pointerdown', (e) => { from = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointermove', (e) => {
        if (!from) return;
        ui.preview.orbit(e.clientX - from[0], e.clientY - from[1]);
        from = [e.clientX, e.clientY];
        onTurn();
    });
    for (const name of ['pointerup', 'pointerleave']) {
        canvas.addEventListener(name, () => { from = null; });
    }
}
