// surveyareas.js — Survey → Areas: woods, meadows and water drawn on the map
// (PLAN-editors.md §2.4; EDT.19-22, docs/design/splatworld-v11.dc.html 11d).
//
// A strip of tools over the map, the kinds down the left, the map in the
// middle and the selected area's fields down the right. The lines on the map
// are Build → Lines' and are read-only here; clicking one says so. What an
// area is, is data (client/lib/kinds.js); what may be written, the database's
// row-level security (Invariant 6).

import * as api from './api.js';
import { readFeatures } from './edit.js';
import { buildAreasMap, fill, frame } from './areasmap.js';
import { loadOl } from './olboot.js';
import { el } from './tabbar.js';

const HTML = `
<div class="ar-top">
  <div class="ar-tools"></div>
  <select class="ar-land"></select>
  <span class="ar-status status"></span>
</div>
<div class="ar-body">
  <aside class="ar-left"></aside>
  <div class="ar-map"><div class="ar-tag mono" hidden></div></div>
  <aside class="ar-right"></aside>
</div>`;

export function mountSurveyAreas(host) {
    const node = el('div', { className: 'ar' });
    node.innerHTML = HTML;
    host.append(node);
    const q = (sel) => node.querySelector(sel);
    const state = { m: null, lands: [], land: null, lines: [], areas: [], opened: false };
    const say = (msg, bad = false) => {
        q('.ar-status').textContent = msg;
        q('.ar-status').dataset.bad = bad ? '1' : '';
    };
    q('.ar-land').addEventListener('change', (e) => choose(state, q, say, e.target.value));
    return {
        state, q, say,
        async open() {
            if (!state.m) {
                const ol = await loadOl().catch((err) => { say(String(err.message), true); });
                if (!ol) return null;
                const ground = await api.rpc('ground').catch(() => null);
                state.m = buildAreasMap(ol, q('.ar-map'), ground);
                clicks(state, q);
            }
            await lands(state, q);
            if (state.lands.length) await choose(state, q, say, q('.ar-land').value);
            else say('No land of yours to draw areas on.');
            state.m.map.updateSize();
            state.opened = true;
            return state.m;
        },
    };
}

// Every land there is: the player's own to pick from, the rest to be dimmed.
async function lands(state, q) {
    const mine = await api.rpc('my_areas').catch(() => []);
    state.lands = (mine ?? []).filter((a) => a.may_write || a.may_propose);
    const all = await api.select('area', { select: 'id,geom' }).catch(() => []);
    const own = new Set(state.lands.map((a) => a.id));
    fill(state.m, 'lands', [
        ...state.lands.map((a) => ({ id: a.id, geom: a.outline, mine: true })),
        ...all.filter((a) => !own.has(a.id))
            .map((a) => ({ id: a.id, geom: a.geom, mine: false }))]);
    const was = q('.ar-land').value;
    q('.ar-land').replaceChildren(...state.lands.map(
        (a) => new Option(a.rules?.name || 'unnamed land', a.id)));
    if (was) q('.ar-land').value = was;
}

// A land chosen: framed, its areas and every line round it read.
async function choose(state, q, say, id) {
    const land = state.lands.find((a) => a.id === id) ?? state.lands[0];
    if (!land) return;
    state.land = land;
    q('.ar-land').value = land.id;
    const b = land.bbox;
    const pad = 0.002;
    const got = await readFeatures({ west: b.west - pad, south: b.south - pad,
        east: b.east + pad, north: b.north + pad }).catch(() => ({ features: [] }));
    const type = (f) => f.geom?.type ?? '';
    state.lines = got.features.filter((f) => type(f).includes('LineString'));
    state.areas = got.features.filter((f) => type(f).includes('Polygon')
        && f.area_id === land.id && !['building', 'terrainmod'].includes(f.kind));
    fill(state.m, 'lines', state.lines);
    fill(state.m, 'areas', state.areas);
    frame(state.m, b);
    say(`${land.rules?.name ?? 'your land'} · ${state.areas.length} area`
        + `${state.areas.length === 1 ? '' : 's'}`);
}

// A click on a line says where lines are edited; it is not this map's to change.
function clicks(state, q) {
    const tag = q('.ar-tag');
    state.m.map.on('singleclick', (e) => {
        let line = null;
        state.m.map.forEachFeatureAtPixel(e.pixel, (f, layer) => {
            if (layer?.getSource() === state.m.sources.lines) line = f;
            return Boolean(line);
        }, { hitTolerance: 5 });
        tag.hidden = !line;
        if (!line) return;
        tag.textContent = 'Edit in Build → Lines';
        tag.style.left = `${e.pixel[0] + 12}px`;
        tag.style.top = `${e.pixel[1] + 12}px`;
        state.hitLine = line.getId();
    });
}
