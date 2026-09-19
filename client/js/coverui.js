// coverui.js — Settings → Ground cover: what the ground between the drawn
// things is made of.
//
// FND.12. A cover source is a layer the operator's GeoServer publishes as a
// class raster — one flat colour per class. This is where they add one, read
// the classes out of it, and say which of the world's own words each class is:
// this colour is `landuse=forest`. What a `landuse=forest` then looks like is
// its symbol's `paint` layer (Settings → Symbols), not anything here.
//
// It decides nothing and computes nothing about the world. The mapping is
// rows an admin writes under row-level security (db/0166), and it reaches the
// world only when somebody applies it, like a symbol (FND.8).

import * as api from './api.js';
import { el } from './poolui.js';
import { colourOf, sldFor } from './coversld.js';
import { classesIn, coverTileUrl } from './covertile.js';

const HTML = `
<div class="cv-cols">
  <div class="cv-left">
    <span class="label">Sources</span>
    <div class="note">A cover source is a layer your GeoServer publishes as a
      picture — one flat colour per class. A raster of classes already is one;
      a vector layer is one once you publish it with the style below.</div>
    <label>GeoServer<input class="cv-url"
      placeholder="the one in Setup, or another"></label>
    <div class="row">
      <input class="cv-user" placeholder="admin">
      <input class="cv-pw" type="password" placeholder="password">
      <button type="button" class="cv-connect">Ask it what it draws</button>
    </div>
    <div class="row">
      <label>Layer<select class="cv-layer"><option value="">connect first</option></select></label>
      <label>Priority<input class="cv-priority" type="number" value="0"></label>
      <button type="button" class="cv-add">Add source</button>
    </div>
    <p class="cv-status status"></p>
    <ul class="cv-sources rows"></ul>
  </div>
  <div class="cv-mid">
    <div class="spread">
      <span class="label">What each class is</span>
      <select class="cv-source"></select>
    </div>
    <div class="note">Read the classes out of the ground the world has cut,
      then say what each one is. A class you do not map is not shown — nothing
      is refused and nothing breaks.</div>
    <div class="row">
      <button type="button" class="cv-read">Read the classes</button>
      <label>in the attribute<input class="cv-field" placeholder="OBJEKTART"></label>
      <button type="button" class="cv-sld">Download style for GeoServer</button>
    </div>
    <table class="cv-map"><tbody></tbody></table>
    <div class="row">
      <button type="button" class="cv-save primary">Keep this mapping</button>
    </div>
    <p class="cv-said status"></p>
  </div>
</div>`;

const post = (path, body) => fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
}).then((r) => r.json());

const short = (text) => String(text ?? '').split('\n')[0].slice(0, 200);

// Every kind a class may be, and every property of it, so the mapping is
// written in the world's own vocabulary rather than in free text (db/0040).
async function vocabulary() {
    const kinds = await api.rpc('vocabulary', { applies_to: 'feature' }).catch(() => []);
    return (kinds ?? []).filter((k) => k.geometry);
}

export function mountCover(host) {
    const box = document.createElement('div');
    box.innerHTML = HTML;
    host.append(box);
    const q = (sel) => box.querySelector(sel);
    const say = (sel, text, bad = false) => {
        const node = q(sel);
        node.textContent = text;
        node.dataset.bad = bad ? '1' : '';
    };
    const state = { sources: [], found: [], kinds: [], rows: [], at: null };

    async function show() {
        state.kinds = await vocabulary();
        state.sources = await api.rpc('cover_draft').catch(() => []);
        listSources(q, state, show);
        const chosen = q('.cv-source');
        chosen.replaceChildren(...state.sources.map(
            (s) => new Option(s.layer, String(s.id))));
        if (state.at && state.sources.some((s) => s.id === state.at)) {
            chosen.value = String(state.at);
        }
        state.at = Number(chosen.value) || state.sources[0]?.id || null;
        drawRows(q, state);
        return state.sources;
    }

    q('.cv-connect').onclick = () => connect(q, say, state);
    q('.cv-add').onclick = () => addSource(q, say, state, show);
    q('.cv-source').onchange = () => { state.at = Number(q('.cv-source').value); load(q, state); };
    q('.cv-read').onclick = () => readClasses(q, say, state);
    q('.cv-save').onclick = () => saveMap(q, say, state, show);
    q('.cv-sld').onclick = () => downloadSld(q, state);

    show();
    return { refresh: show };
}

// Every layer that GeoServer draws. A cover reaches the world over WMS — a
// raster of classes, or a vector painted as one — so what may be offered here
// is what WMS lists, not what WFS or WCS do.
async function connect(q, say, state) {
    const url = q('.cv-url').value.trim();
    if (!url) { say('.cv-status', 'type the address your GeoServer opens on', true); return; }
    say('.cv-status', 'asking that GeoServer what it publishes…');
    const probe = await post('/setup/probe', { url, user: q('.cv-user').value.trim() || 'admin',
        password: q('.cv-pw').value }).catch((err) => ({ error: String(err.message ?? err) }));
    if (probe.error) { say('.cv-status', short(probe.error), true); return; }
    state.found = (probe.drawn ?? []).filter((c) => c.bbox?.length === 4);
    q('.cv-layer').replaceChildren(...(state.found.length
        ? state.found.map((c) => new Option(`${c.title ?? c.name} (${c.name})`, c.name))
        : [new Option('nothing it draws says where it is', '')]));
    say('.cv-status', state.found.length
        ? `${state.found.length} layer(s) — pick one and add it`
        : 'connected, but nothing it publishes says where it is', !state.found.length);
}

async function addSource(q, say, state, show) {
    const id = q('.cv-layer').value;
    const chosen = state.found.find((c) => c.name === id);
    if (!chosen) { say('.cv-status', 'connect and pick a layer first', true); return; }
    const [west, south, east, north] = chosen.bbox;
    try {
        await api.rpc('set_ground_layer', {
            kind: 'cover', url: q('.cv-url').value.trim(), layer: id,
            west, south, east, north, priority: Number(q('.cv-priority').value) || 0,
        });
        say('.cv-status', `${id} added — read its classes and map them`);
        await show();
    } catch (err) {
        say('.cv-status', String(err.body?.message ?? err.message ?? err), true);
    }
}

// The classes this source actually has, read off the ground the world cut for
// it — the same picture the compiler reads (client/lib/gen/cover.js).
async function readClasses(q, say, state) {
    const source = state.sources.find((s) => s.id === state.at);
    if (!source) { say('.cv-said', 'add a source first', true); return; }
    say('.cv-said', 'reading the ground…');
    try {
        const found = await classesIn(coverTileUrl(source));
        const known = new Map(state.rows.map((r) => [r.colour, r]));
        state.rows = found.map((c) => known.get(c.colour)
            ?? { ...c, kind: '', key: '', value: '' });
        for (const r of state.rows) {
            r.count = found.find((c) => c.colour === r.colour)?.count ?? 0;
        }
        drawRows(q, state);
        say('.cv-said', state.rows.length
            ? `${state.rows.length} class(es) in it`
            : 'nothing is cut for that source yet — walk over it once', !state.rows.length);
    } catch (err) {
        say('.cv-said', String(err.message ?? err), true);
    }
}

function load(q, state) {
    const source = state.sources.find((s) => s.id === state.at);
    state.rows = Object.entries(source?.class_map ?? {}).map(([colour, what]) => ({
        colour, count: 0, value: what.source_value ?? '',
        kind: what.kind ?? '', key: what.key ?? '', value_of: what.value ?? '',
    }));
    drawRows(q, state);
}

function listSources(q, state, refresh) {
    q('.cv-sources').replaceChildren(...state.sources.map((s) => {
        const gone = el('button', { type: 'button', textContent: 'Remove' });
        gone.onclick = () => api.rpc('drop_ground_layer', { id: s.id }).then(refresh);
        const mapped = Object.keys(s.class_map ?? {}).length;
        return el('li', {}, [
            el('span', { className: 'mono', textContent: s.layer }),
            el('span', { className: 'muted',
                textContent: ` priority ${s.priority} · ${mapped} class(es) mapped` }),
            gone]);
    }));
}

// One row per class: its colour as the raster carries it, and the world's own
// words for what it is. Unmapped first, and said to be unmapped.
function drawRows(q, state) {
    const rows = [...state.rows].sort((a, b) =>
        Number(Boolean(b.kind)) - Number(Boolean(a.kind)) || a.colour.localeCompare(b.colour));
    q('.cv-map tbody').replaceChildren(...rows.map((r) => {
        const swatch = el('span', { className: 'cv-swatch' });
        swatch.style.background = r.colour;
        const kind = el('select', { className: 'cv-kind' });
        kind.replaceChildren(new Option('not shown', ''),
            ...state.kinds.map((k) => new Option(k.label || k.name, k.name)));
        kind.value = r.kind ?? '';
        const key = el('input', { className: 'cv-key', value: r.key ?? '',
            placeholder: 'landuse' });
        const value = el('input', { className: 'cv-value', value: r.value_of ?? '',
            placeholder: 'forest' });
        const source = el('input', { className: 'cv-src', value: r.value ?? '',
            placeholder: 'Wald' });
        for (const [node, field] of [[kind, 'kind'], [key, 'key'],
            [value, 'value_of'], [source, 'value']]) {
            node.onchange = () => { r[field] = node.value.trim(); drawRows(q, state); };
        }
        return el('tr', { className: r.kind ? '' : 'cv-unmapped' }, [
            el('td', {}, [swatch]),
            el('td', { className: 'mono', textContent: r.colour }),
            el('td', {}, [source]),
            el('td', {}, [kind]),
            el('td', {}, [key]),
            el('td', {}, [value]),
            el('td', { className: 'muted', textContent: r.kind ? '' : 'not shown' }),
        ]);
    }));
}

async function saveMap(q, say, state, show) {
    const source = state.sources.find((s) => s.id === state.at);
    if (!source) { say('.cv-said', 'add a source first', true); return; }
    const map = {};
    for (const r of state.rows) {
        if (!r.kind || !r.key || !r.value_of) continue;
        map[r.colour] = { kind: r.kind, key: r.key, value: r.value_of,
            source_value: r.value || undefined };
    }
    try {
        await api.rpc('set_cover_map', { id: source.id, map });
        say('.cv-said', `${Object.keys(map).length} class(es) mapped — not in the`
            + ' world yet. Apply it in Symbols.');
        await show();
    } catch (err) {
        say('.cv-said', String(err.body?.message ?? err.message ?? err), true);
    }
}

// A class with no colour yet is given one: the code is its place in the list,
// and the colour follows from it (client/js/coversld.js).
function downloadSld(q, state) {
    const source = state.sources.find((s) => s.id === state.at);
    const rows = state.rows.map((r, i) => ({ value: r.value,
        colour: r.colour || colourOf(i + 1) }));
    const blob = new Blob([sldFor(source?.layer ?? 'cover', q('.cv-field').value.trim()
        || 'class', rows)], { type: 'application/vnd.ogc.sld+xml' });
    const a = el('a', { href: URL.createObjectURL(blob),
        download: `${(source?.layer ?? 'cover').replace(/[^a-z0-9]+/gi, '-')}.sld` });
    a.click();
    URL.revokeObjectURL(a.href);
}
