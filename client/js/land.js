// land.js — your land, in the world and in the panel (design 3b).
//
// The panel is the artboard: every area you may touch, then the one you chose
// with its counts, how many approvals it needs, who else may work on it, and
// what is waiting for a decision. Every number and every name comes from an
// RPC that already existed — my_areas, area_progress, area_grants,
// my_proposals — so the panel states the world rather than deciding anything.
//
// The outline in the world is drawn rather than modelled — three lines a
// frame, no entity, nothing to dispose — because it is a hint about
// permission, not part of the world. Cyan is yours, amber is somebody's you
// may propose to, grey is everyone else's: the legend's three colours.

import * as api from './api.js';
import { askField, asking, landRows, selected } from './landui.js';

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

// A polygon's rings, as [lon, lat] pairs, whatever GeoJSON shape it arrived in.
export function ringsOf(outline) {
    if (!outline) return [];
    if (outline.type === 'Polygon') return outline.coordinates;
    if (outline.type === 'MultiPolygon') return outline.coordinates.flat();
    return [];
}

// How far apart two points of a drawn boundary may be before the ground
// between them is asked about. A boundary drawn in QGIS is four corners, and
// four corners over a mountainside is a line through the inside of the
// mountain: the corners are on the ground and everything between them is a
// straight line in the air. So every edge is walked at this spacing and each
// step put on the ground under it.
const DRAPE_M = 12;
// How many steps one edge may be cut into. A boundary can be kilometres long
// and this is drawn every frame; past this the line is coarser rather than the
// frame slower.
const DRAPE_MAX = 256;

// Every point of a boundary, on the ground: the ring's own corners with as
// many steps between them as the hill needs.
export function drape(ring, origin, terrain, up = 1.5) {
    const out = [];
    const at = (lon, lat) => {
        const p = origin.localOf({ lon, lat, h: 0 });
        const ground = terrain?.heightAt(p);
        return { x: p.x, y: (ground ?? p.y) + up, z: p.z };
    };
    for (let i = 0; i < ring.length; i++) {
        const [lon, lat] = ring[i];
        const next = ring[i + 1];
        out.push(at(lon, lat));
        if (!next) break;
        const a = origin.localOf({ lon, lat, h: 0 });
        const b = origin.localOf({ lon: next[0], lat: next[1], h: 0 });
        const steps = Math.min(DRAPE_MAX,
            Math.floor(Math.hypot(b.x - a.x, b.z - a.z) / DRAPE_M));
        for (let s = 1; s < steps; s++) {
            const t = s / steps;
            out.push(at(lon + (next[0] - lon) * t, lat + (next[1] - lat) * t));
        }
    }
    return out;
}

// Draping a kilometre of boundary is a few hundred questions to the terrain,
// and this is drawn every frame: asking them every frame is a page that runs
// at one frame a second. The answers are kept until the ground under them can
// have changed — a new tile arrived, or the floating anchor moved.
const draped = new Map();
const DRAPE_MS = 500;

function ringsFor(area, origin, terrain, now) {
    const at = origin.anchor;
    const key_ = `${area.id}:${at.lon.toFixed(5)},${at.lat.toFixed(5)}`;
    const had = draped.get(area.id);
    if (had && had.key === key_ && now - had.at < DRAPE_MS) return had.rings;
    const rings = ringsOf(area.outline)
        .map((ring) => drape(ring, origin, terrain).map((p) => [p.x, p.y, p.z]));
    draped.set(area.id, { key: key_, at: now, rings });
    return rings;
}

// Every area, drawn on the ground under it rather than between its corners.
export function drawAreas(ctx, areas) {
    const { pc, app, origin, terrain } = ctx;
    const now = Date.now();
    const live = new Set();
    for (const area of areas ?? []) {
        live.add(area.id);
        const colour = area.mine ? new pc.Color(0.35, 0.85, 0.95)
            : area.may_propose ? new pc.Color(0.95, 0.78, 0.35)
                : new pc.Color(0.55, 0.6, 0.65);
        for (const ring of ringsFor(area, origin, terrain, now)) {
            let last = null;
            for (const [x, y, z] of ring) {
                const to = new pc.Vec3(x, y, z);
                if (last) app.drawLine(last, to, colour);
                last = to;
            }
        }
    }
    for (const id of [...draped.keys()]) if (!live.has(id)) draped.delete(id);
}

export const areaName = (a) => a?.rules?.name || 'unnamed land';

// The name on the ground (SPEC §3.2: "the boundary and name are drawn on the
// ground"). A line in the world cannot carry letters, so the letters are HTML
// held over the spot the land's centre projects to — it moves with the camera
// and disappears when the land is behind you.
export function labelAreas(ctx, areas, host) {
    const named = (areas ?? []).filter((a) => a.centre?.lon !== undefined)
        .map((a) => ({ key: a.id, words: areaName(a), at: a.centre, up: 3 }));
    return labelWorld(ctx, named, host, 'area');
}

// SPEC §0.3: a saved object is one everybody sees, "marked not yet rendered",
// until its tile is published with it inside. The mark is a word over the
// thing, because a model standing in a world of splats looks like any other
// model and the difference is what the world knows about it.
export function labelObjects(ctx, objects, host) {
    // `h` on an instance is metres above sea level, not above the ground: a
    // label placed at ground + h was six hundred metres over the Rhone.
    const marks = (objects ?? []).filter((o) => o.lon !== undefined)
        .map((o) => ({ key: `i:${o.id}`, words: 'not yet rendered',
            at: { lon: o.lon, lat: o.lat, h: o.h }, up: 2, dim: true }));
    return labelWorld(ctx, marks, host, 'object');
}

// PLAN-money.md §3: an item is never baked; one lying on the ground is marked
// over the splats where it lies, the way a mover is drawn over them.
export function labelItems(ctx, items, host) {
    const marks = (items ?? []).map((i) => ({ key: `item:${i.id}`, words: 'Wallet',
        at: { lon: i.lon, lat: i.lat, h: i.h }, up: 0.4 }));
    return labelWorld(ctx, marks, host, 'item');
}

// The words, held over the spot they belong to. A line in the world cannot
// carry letters, so the letters are HTML over the canvas: it moves with the
// camera and disappears when the spot is behind you.
function labelWorld(ctx, marks, host, group) {
    const { pc, app, origin, terrain } = ctx;
    if (!host) return;
    const camera = app.root.children.find((c) => c.camera)?.camera;
    if (!camera) return;
    const seen = new Set();
    for (const mark of marks) {
        seen.add(mark.key);
        let label = host.querySelector(`[data-key="${mark.key}"]`);
        if (!label) {
            label = document.createElement('div');
            label.className = 'world-label';
            label.dataset.key = mark.key;
            label.dataset.group = group;
            if (mark.dim) label.dataset.tone = 'warn';
            host.append(label);
        }
        label.textContent = mark.words;
        // A mark that knows its own elevation is drawn there; one that does not
        // sits on the ground under it.
        const known = Number.isFinite(mark.at.h);
        const p = origin.localOf({ lon: mark.at.lon, lat: mark.at.lat,
            h: known ? mark.at.h : 0 });
        const base = known ? p.y : (terrain?.heightAt(p) ?? p.y);
        const at = new pc.Vec3(p.x, base + mark.up, p.z);
        const screen = camera.worldToScreen(at);
        // Behind the camera, or off the side: not drawn rather than drawn in
        // the wrong place.
        const off = screen.z <= 0 || screen.x < 0 || screen.y < 0
            || screen.x > app.graphicsDevice.canvas.clientWidth
            || screen.y > app.graphicsDevice.canvas.clientHeight;
        label.hidden = off;
        label.style.left = `${Math.round(screen.x)}px`;
        label.style.top = `${Math.round(screen.y)}px`;
    }
    for (const node of host.querySelectorAll(`.world-label[data-group="${group}"]`)) {
        if (!seen.has(node.dataset.key)) node.remove();
    }
}

// Everything the chosen area's card shows, in one round of requests.
async function cardOf(area) {
    const empty = {
        contents: [], drawn: [], progress: null, grants: [], proposals: [],
        refusal: null, asks: [], project: null,
    };
    if (!area) return empty;
    const [contents, drawn, progress, grants, proposals, refusal, asks, project]
        = await Promise.all([
            api.rpc('area_contents', { area_id: area.id }).catch(() => []),
            api.rpc('area_drawn', { area_id: area.id }).catch(() => []),
            api.rpc('area_progress', { area_id: area.id }).catch(() => null),
            api.rpc('area_grants', { area_id: area.id }).catch(() => []),
            api.rpc('my_proposals').catch(() => []),
            api.rpc('area_refusal', { area_id: area.id }).catch(() => null),
            api.rpc('grant_requests', { area_id: area.id }).catch(() => []),
            api.rpc('project_state').catch(() => null),
        ]);
    return {
        contents: contents ?? [],
        drawn: drawn ?? [],
        progress,
        grants: grants ?? [],
        proposals: (proposals ?? []).filter((p) => p.area_id === area.id),
        refusal: refusal?.note ? refusal : null,
        asks: asks ?? [],
        project,
    };
}

async function removing(item, onRemove, say, reload) {
    try {
        await onRemove(item);
        say(`${item.name || item.san} removed`);
        await reload();
    } catch (err) {
        say(String(err.body?.message ?? err.message ?? err), true);
    }
}

// A change drawn in QGIS reaches the page by itself, within half a minute
// (SPEC §3.3 step 4): nobody is going to press reload after every save.
const WATCH_MS = 10000;

// The land you are standing on, when it is not already one of yours: SPEC §2.4
// gives it the same card, and §3.11 is asked for from it.
const sayInto = (status) => (msg, bad = false) => {
    status.textContent = msg;
    status.dataset.bad = bad ? '1' : '';
};

const underYou = (state, ctx) => (state.under
    && !state.areas.some((a) => a.id === state.under.id)
    ? asking(state.under, ctx, ctx.askNote) : null);

// The card for the land you are standing on is its own box, redrawn only when
// that land changes. See client/js/permission.js: replacing it takes the note
// field out of the document and back in, which blurs it, and a redraw in the
// middle of somebody typing sends the rest of their sentence to nowhere.
function redraw(under, list, detail, state, ctx) {
    const id = state.under?.id ?? null;
    if (id !== ctx.shown()) {
        ctx.wasShown(id);
        under.replaceChildren(...[underYou(state, ctx)].filter(Boolean));
    }
    list.replaceChildren(...landRows(state, ctx.pick));
    const area = state.areas.find((a) => a.id === state.chosen);
    // Only when it would say something different. The panel refreshes every
    // ten seconds whether or not the world moved, and a card rebuilt to say
    // the same thing is a card whose buttons are somewhere else every time
    // somebody reaches for one.
    const sign = cardSignature(area, state);
    if (sign === ctx.drawn()) return;
    ctx.wasDrawn(sign);
    detail.replaceChildren(...selected(area, state, {
        ...ctx, refresh: () => ctx.load(area),
    }).filter(Boolean));
}

// Everything the card puts on the screen, and nothing else: the area's own
// outline is kilobytes of coordinates and is not in it.
const cardSignature = (area, state) => JSON.stringify([
    area?.id ?? null, area?.detail, area?.rules?.name, area?.mine,
    area?.may_write, area?.may_propose, area?.owner,
    state.progress, state.drawn, state.contents, state.grants, state.asks,
    state.proposals, state.refusal, state.project, state.giveBack,
]);

// Nodes the panel makes once and moves into each card it draws. A card is
// redrawn whenever anything about the land changes and every ten seconds
// besides, and a node that is rebuilt is a node that loses what it was
// holding: the sentence somebody was typing, or the answer to the button they
// pressed two hundred milliseconds ago.
function keeper() {
    const kept = new Map();
    return (name, make) => {
        if (!kept.has(name)) kept.set(name, make());
        return kept.get(name);
    };
}

function landParts(host) {
    const parts = {
        under: el('div', { className: 'land-under-box' }),
        list: el('ul', { className: 'rows land-areas' }),
        detail: el('div', { className: 'land-detail' }),
        status: el('p', { className: 'land-status status' }),
    };
    host.append(parts.under, parts.list, parts.detail, parts.status);
    return parts;
}

export function mountLand(host, { onGo = () => {}, onRemove = () => {},
    onAreas = () => {}, openPanel = () => {} } = {}) {
    const { under, list, detail, status } = landParts(host);
    const state = {
        areas: [], chosen: null, contents: [], drawn: [], progress: null,
        grants: [], proposals: [], asks: [], under: null,
        giveBack: null, project: null,
    };
    const say = sayInto(status);

    // One place where the panel is redrawn, so every action ends the same way.
    // What is half-typed into the card survives it being redrawn, because the
    // field itself is never redrawn: it is moved into each new card.
    const keep = keeper();
    const askNote = keep('ask', askField);
    // Which land is between the two presses of "Give this land back", and what
    // the world said would go with it.
    const confirming = (asked) => { state.giveBack = asked; draw(); };
    // Which land the standing-on card is showing, so it is not rebuilt to say
    // the same thing about the same land.
    // What each of the two cards is showing, so neither is rebuilt to say the
    // same thing again.
    const seen = { under: undefined, card: undefined };
    const draw = () => redraw(under, list, detail, state,
        { pick, onGo, onRemove: remove, say, load, api, openPanel, askNote, keep,
            clearAsk: () => { askNote.value = ''; }, reload: refresh, confirming,
            shown: () => seen.under, wasShown: (id) => { seen.under = id; },
            drawn: () => seen.card, wasDrawn: (sign) => { seen.card = sign; } });

    async function pick(area) {
        state.chosen = area?.id ?? null;
        draw();
        await load(area);
    }

    async function load(area) {
        Object.assign(state, await cardOf(area));
        draw();
    }

    const remove = (item) => removing(item, onRemove, say,
        () => load(state.areas.find((a) => a.id === state.chosen)));
    async function refresh() {
        state.areas = await api.rpc('my_areas').catch(() => []);
        const chosen = state.areas.find((a) => a.id === state.chosen)
            ?? state.areas.find((a) => a.mine) ?? state.areas[0];
        state.chosen = chosen?.id ?? null;
        draw();
        onAreas(state.areas);
        if (chosen) await load(chosen);
        return state.areas;
    }

    refresh();
    setInterval(() => { if (api.userId()) refresh(); }, WATCH_MS);
    return {
        refresh,
        // SPEC §2.4: the land you are standing on gets a card too, whoever's
        // it is — that is where you ask to build on somebody else's.
        standingOn(area) {
            const id = area?.id ?? null;
            if (id === (state.under?.id ?? null)) return;
            state.under = area ?? null;
            draw();
        },
        areas: () => state.areas,
        chosen: () => state.chosen,
        inside: pick,
        // What stands on the chosen land, for the map and for the first of the
        // chrome's five stages.
        things: () => state.contents,
    };
}
