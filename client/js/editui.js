// editui.js — the map half of edit.html: an OpenLayers map over the world's
// own ortho pyramid, the areas drawn on top of it, and the form for the props
// each kind of feature carries.
//
// The DOM and the map live here; what a feature is and how it is written live
// in edit.js. OpenLayers arrives as the global `ol` (the built bundle in the
// page's script tag), because a no-bundler client cannot resolve the bare
// specifiers its ES modules import each other by.
//
// Nothing here decides who may edit: the panel says what db/0003_rls.sql is
// going to say, and a refusal still comes back from the database (Invariant 6).

import * as api from './api.js';
import { KIND_NAMES, KINDS, dropFeature, geometryOf, permissionOf, propsFrom,
    readAreas, readFeatures, saveFeature, valuesOf } from './edit.js';

const HTML = `
<div class="edit-head">areas</div>
<ul class="edit-areas"></ul>
<p class="edit-perm muted"></p>
<div class="edit-head">feature</div>
<label>kind <select class="edit-kind"></select></label>
<div class="edit-props"></div>
<div class="edit-acts">
  <button type="button" class="edit-draw">draw</button>
  <button type="button" class="edit-save">save</button>
  <button type="button" class="edit-delete">delete</button>
</div>
<p class="edit-count muted"></p>
<p class="edit-status muted"></p>`;

const COLOURS = {
    road: '#d8b84a', forest: '#54a15a', water: '#4a8fc4',
    footprint: '#d0794f', terrainmod: '#9b7fd0',
};
const AREA_COLOURS = { write: '#5fa96a', propose: '#d8b84a', read: '#6d7780' };
const PERMS = {
    write: 'you may draw here',
    propose: 'your changes here become proposals',
    read: 'read-only: you hold no right on this area',
    none: 'no area — sign in, or move the map over one',
};

// The seeded ortho pyramid has only the even zooms (ARCHITECTURE §2), so the
// tile grid is built from those rather than from the usual XYZ ladder: a z13
// request would be a permanent 404. This is the world's own imagery from the
// file store — Invariant 10 leaves no room for a basemap service, and drawing
// over what the compiler will read is the point anyway.
const ORTHO_ZOOMS = [6, 8, 10, 12, 14];
const R0 = 156543.03392804097;

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
    return node;
};

const short = (id) => String(id ?? '').slice(0, 8);

const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},`
    + `${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

// --------------------------------------------------------------------- map

function orthoLayer(ol, filesUrl) {
    const grid = new ol.tilegrid.TileGrid({
        extent: ol.proj.get('EPSG:3857').getExtent(),
        resolutions: ORTHO_ZOOMS.map((z) => R0 / 2 ** z),
        tileSize: 256,
    });
    const url = ([i, x, y]) => `${filesUrl}/geo/ortho/${ORTHO_ZOOMS[i]}/${x}/${y}.webp`;
    return new ol.layer.Tile({
        source: new ol.source.XYZ({ tileGrid: grid, tileUrlFunction: url }),
    });
}

function styleFor(ol, kind, on) {
    const colour = COLOURS[kind] ?? '#9aa4ad';
    return new ol.style.Style({
        stroke: new ol.style.Stroke({ color: colour, width: on ? 4 : 2 }),
        fill: new ol.style.Fill({ color: rgba(colour, on ? 0.45 : 0.2) }),
        image: new ol.style.Circle({ radius: 4,
            fill: new ol.style.Fill({ color: colour }) }),
    });
}

function areaStyleFor(ol, may) {
    const colour = AREA_COLOURS[may] ?? AREA_COLOURS.read;
    return new ol.style.Style({
        stroke: new ol.style.Stroke({ color: colour, width: 2, lineDash: [7, 5] }),
        fill: new ol.style.Fill({ color: rgba(colour, 0.05) }),
    });
}

function buildMap(ol, target, filesUrl) {
    const cache = new Map();
    const style = (f, on) => {
        const key = `${f.get('kind')}:${on}`;
        if (!cache.has(key)) cache.set(key, styleFor(ol, f.get('kind'), on));
        return cache.get(key);
    };
    const areas = new ol.source.Vector();
    const features = new ol.source.Vector();
    const layer = new ol.layer.Vector({ source: features, style: (f) => style(f, false) });
    const map = new ol.Map({
        target,
        layers: [orthoLayer(ol, filesUrl),
            new ol.layer.Vector({ source: areas,
                style: (f) => areaStyleFor(ol, f.get('may')) }),
            layer],
        view: new ol.View({ center: [0, 0], zoom: 2 }),
    });
    return { map, layer, areas, features, style, gj: new ol.format.GeoJSON() };
}

const PROJ = { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' };

const geoOf = (ctx, feature) =>
    ctx.gj.writeGeometryObject(feature.getGeometry(), { ...PROJ, decimals: 9 });

function viewBbox(map, ol) {
    const [west, south, east, north] = ol.proj.transformExtent(
        map.getView().calculateExtent(map.getSize()), 'EPSG:3857', 'EPSG:4326');
    return { west, south, east, north };
}

// -------------------------------------------------------------------- form

function renderForm(host, kind, props) {
    const values = valuesOf(kind, props);
    host.replaceChildren(...(KINDS[kind]?.fields ?? []).map((f) => {
        const input = f.type === 'select'
            ? el('select', { className: 'edit-field' },
                ...f.options.map((o) => new Option(o, o)))
            : el('input', { className: 'edit-field', type: f.type, step: String(f.step ?? 1) });
        input.dataset.key = f.key;
        input.value = values[f.key] ?? '';
        return el('label', { textContent: `${f.label} ` }, input);
    }));
}

const readForm = (host) => Object.fromEntries(
    [...host.querySelectorAll('.edit-field')].map((i) => [i.dataset.key, i.value]));

// ------------------------------------------------------------------ paint

function paintAreas(ctx, areas) {
    ctx.state.areas = areas;
    const rows = areas.filter((a) => a.geom).map((a) => {
        const f = ctx.gj.readFeature({ type: 'Feature', geometry: a.geom,
            properties: { may: permissionOf(a) } }, PROJ);
        f.setId(a.id);
        return f;
    });
    ctx.areas.clear();
    ctx.areas.addFeatures(rows);
}

function paintFeatures(ctx, rows) {
    const feats = rows.map((r) => {
        const f = ctx.gj.readFeature({ type: 'Feature', geometry: r.geom,
            properties: { kind: r.kind, props: r.props ?? {}, area_id: r.area_id,
                rev: r.rev } }, PROJ);
        f.setId(r.id);
        return f;
    });
    const held = ctx.state.selected?.getId();
    ctx.select?.getFeatures().clear();
    ctx.state.selected = null;
    ctx.features.clear();
    ctx.features.addFeatures(feats);
    // A drawn feature nobody has saved yet is not in the world's answer, so it
    // is put back rather than disappearing under a refresh.
    if (ctx.state.pending) ctx.features.addFeature(ctx.state.pending);
    // A read makes new objects; the selection has to be moved onto the new one
    // or Modify would go on dragging a feature no layer holds any more. Pushing
    // it fires no select event, so the form keeps what was typed into it.
    const again = held ? ctx.features.getFeatureById(held) : null;
    if (again) {
        ctx.select.getFeatures().push(again);
        ctx.state.selected = again;
    }
}

function areaRow(ctx, area) {
    const may = permissionOf(area);
    const b = el('button', { type: 'button',
        textContent: `${short(area.id)} · detail ${area.detail} · ${may}` });
    b.onclick = () => pick(ctx, area);
    const li = el('li', { className: 'edit-area', title: area.id }, b);
    li.dataset.on = area.id === ctx.state.target?.id ? '1' : '';
    li.dataset.may = may;
    return li;
}

function renderAreas(ctx) {
    ctx.q('.edit-areas').replaceChildren(
        ...ctx.state.areas.map((a) => areaRow(ctx, a)));
    ctx.q('.edit-perm').textContent = PERMS[permissionOf(ctx.state.target)];
}

// ------------------------------------------------------------------ acts

function pick(ctx, area) {
    ctx.state.target = area;
    if (area?.centre) {
        ctx.map.getView().setCenter(
            ctx.ol.proj.fromLonLat([area.centre.lon, area.centre.lat]));
        ctx.map.getView().setZoom(15);
    }
    renderAreas(ctx);
    return refresh(ctx);
}

async function refresh(ctx) {
    const view = ctx.map.getView();
    const [lon, lat] = ctx.ol.proj.toLonLat(view.getCenter());
    const [areas, world] = await Promise.all([
        readAreas({ lon, lat }).catch(() => []),
        readFeatures(viewBbox(ctx.map, ctx.ol)).catch((err) => {
            ctx.fail(err);
            return { features: [], tiles: 0, tooWide: false };
        }),
    ]);
    paintAreas(ctx, areas);
    // Signing in should land the map on your own ground rather than on the
    // null island the view starts at.
    if (!ctx.state.target && areas.length) {
        return pick(ctx, areas.find((a) => a.may_write) ?? areas[0]);
    }
    renderAreas(ctx);
    paintFeatures(ctx, world.features);
    ctx.q('.edit-count').textContent = world.tooWide
        ? 'zoom in to load features'
        : `${world.features.length} feature(s) · ${world.tiles} tile(s)`;
    return world;
}

// The area a change lands in: an existing feature keeps its own, a new one
// takes the targeted area. Which of the two the user may write is not decided
// here — saveFeature() asks, and the database answers.
const areaFor = (ctx, f) => (f?.get('area_id')
    ? ctx.state.areas.find((a) => a.id === f.get('area_id')) ?? null
    : ctx.state.target);

async function save(ctx) {
    const f = ctx.state.pending ?? ctx.state.selected;
    if (!f) { ctx.say('draw or select something first', true); return null; }
    const area = areaFor(ctx, f);
    if (!area) { ctx.say('no area here', true); return null; }
    const kind = ctx.q('.edit-kind').value;
    const geom = geoOf(ctx, f);
    // Kinds can be re-typed, but a road is a line and a forest is a ring: a
    // forest with no ring compiles to nothing at all, silently. Multi and
    // single are the same shape as far as `assemble` is concerned.
    const base = (t) => String(t).replace(/^Multi/, '');
    if (base(geom.type) !== base(geometryOf(kind))) {
        ctx.say(`a ${kind} is a ${geometryOf(kind)}, not a ${geom.type}`, true);
        return null;
    }
    try {
        const res = await saveFeature(area, { id: f.getId(), kind, geom,
            props: propsFrom(kind, readForm(ctx.q('.edit-props'))) });
        ctx.state.pending = null;
        ctx.say(`${res.mode === 'write' ? 'saved' : 'proposed'} ${short(res.id)}`);
        await refresh(ctx);
        return res;
    } catch (err) {
        ctx.fail(err);
        return null;
    }
}

async function remove(ctx) {
    const f = ctx.state.selected;
    if (!f?.getId()) { ctx.say('select a saved feature first', true); return null; }
    try {
        const res = await dropFeature(areaFor(ctx, f), f.getId());
        ctx.state.selected = null;
        ctx.say(`${res.mode === 'write' ? 'deleted' : 'proposed'} ${short(res.id)}`);
        await refresh(ctx);
        return res;
    } catch (err) {
        ctx.fail(err);
        return null;
    }
}

// ----------------------------------------------------------- interactions

// Select is switched off for the duration: both interactions want the same
// clicks, and a click that starts a polygon must not also pick a feature up.
function startDraw(ctx) {
    const { ol, map, state } = ctx;
    if (state.draw) map.removeInteraction(state.draw);
    state.pending = null;
    ctx.select.getFeatures().clear();
    ctx.select.setActive(false);
    state.draw = new ol.interaction.Draw({ type: geometryOf(ctx.q('.edit-kind').value) });
    state.draw.on('drawend', (e) => {
        e.feature.set('kind', ctx.q('.edit-kind').value);
        state.pending = e.feature;
        ctx.features.addFeature(e.feature);
        // Removing an interaction from inside its own event is asking for
        // trouble; deactivating it is not.
        state.draw.setActive(false);
        ctx.select.setActive(true);
        ctx.say('drawn — press save');
    });
    map.addInteraction(state.draw);
    ctx.say(`click to draw a ${ctx.q('.edit-kind').value}`);
}

function selectionChanged(ctx, feature) {
    // Picking up the shape just drawn must not throw away the sketch, or the
    // props typed for it: it is still the thing waiting to be saved.
    if (feature && feature === ctx.state.pending) return;
    ctx.state.selected = feature ?? null;
    ctx.state.pending = null;
    if (!feature) return;
    const kind = feature.get('kind');
    if (kind) ctx.q('.edit-kind').value = kind;
    renderForm(ctx.q('.edit-props'), kind ?? ctx.q('.edit-kind').value, feature.get('props'));
    ctx.say(`${kind} ${short(feature.getId())} · rev ${feature.get('rev') ?? '?'}`);
}

function interactions(ctx) {
    const { ol, map } = ctx;
    const select = new ol.interaction.Select({ layers: [ctx.layer], hitTolerance: 5,
        style: (f) => ctx.style(f, true) });
    select.on('select', (e) => selectionChanged(ctx, e.selected[0]));
    const modify = new ol.interaction.Modify({ features: select.getFeatures() });
    modify.on('modifyend', () => ctx.say('moved — press save'));
    map.addInteraction(select);
    map.addInteraction(modify);
    map.addInteraction(new ol.interaction.Snap({ source: ctx.features }));
    ctx.select = select;
}

// ------------------------------------------------------------------ mount

export function mountEditor(doc, { mountAuth } = {}) {
    const ol = window.ol;
    if (!ol) throw new Error('OpenLayers did not load');
    const panel = doc.getElementById('panel');
    panel.innerHTML = HTML;
    const q = (sel) => panel.querySelector(sel);
    const say = (msg, bad = false) => {
        const node = q('.edit-status');
        node.textContent = msg;
        node.className = `edit-status ${bad ? 'bad' : 'muted'}`;
    };
    const built = buildMap(ol, doc.getElementById('map'), api.endpoints().files);
    const ctx = { ol, doc, q, say, ...built,
        fail: (err) => say(String(err.body?.message ?? err.message ?? err), true),
        state: { areas: [], target: null, pending: null, selected: null, draw: null } };

    for (const k of KIND_NAMES) q('.edit-kind').append(new Option(k, k));
    q('.edit-kind').value = 'forest';
    renderForm(q('.edit-props'), 'forest', null);
    interactions(ctx);
    wire(ctx, mountAuth);
    ctx.map.updateSize();
    refresh(ctx);
    return {
        state: ctx.state, map: ctx.map,
        refresh: () => refresh(ctx),
        pick: (id) => pick(ctx, ctx.state.areas.find((a) => a.id === id) ?? null),
        draw: () => startDraw(ctx),
        save: () => save(ctx),
        remove: () => remove(ctx),
    };
}

function wire(ctx, mountAuth) {
    const { q, state } = ctx;
    q('.edit-draw').onclick = () => startDraw(ctx);
    q('.edit-save').onclick = () => save(ctx);
    q('.edit-delete').onclick = () => remove(ctx);
    q('.edit-kind').onchange = () => {
        if (!state.selected) renderForm(q('.edit-props'), q('.edit-kind').value, null);
    };
    // Panning is a new set of tiles to ask about; moveend is once per gesture.
    ctx.map.on('moveend', () => refresh(ctx));
    mountAuth?.(ctx.doc.getElementById('auth'), { onChange: () => refresh(ctx) });
}
