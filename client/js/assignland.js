// assignland.js — the admin's half of SPEC §3.2: who asked for land, drawing
// them some, and taking a piece of it back.
//
// The map is the world's own ground with the land already in it, drawn on a
// canvas (client/js/landmap.js). There is no basemap service to put under it
// (Invariant 10) and the ortho pyramid is not seeded in a fresh world, so what
// it shows is what the world knows: the elevation it was given, where the
// coverage reaches, and whose ground is where.
//
// What is drawn goes into the boundary field as numbers, and the boundary
// field is what is sent — so an admin can correct a corner by typing, and the
// database still refuses anything outside the ground (db/0062).
//
// The map has two jobs and says which it is doing. Draw puts corners down;
// Pick selects the land under the cursor, which is how a piece of it is
// deleted — a list of every land in the world is not how anybody finds the one
// they are looking at.

import * as api from './api.js';
import { handOver } from './handover.js';
import { empty } from './empty.js';
import { groundOver, tileOver } from '../lib/demshade.js';
import { MAP, ZOOM_STEP, areaAt, fitView, panned, paintMap, projection, zoomed }
    from './landmap.js';

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

const saying = (node) => (msg, bad = false) => {
    node.textContent = msg;
    node.dataset.bad = bad ? '1' : '';
};

export const ringText = (points) =>
    points.map(([lon, lat]) => `${lon.toFixed(6)}, ${lat.toFixed(6)}`).join('\n');

// The typed field back to a ring, closed. Anything unreadable is left to the
// database to refuse by name rather than guessed at here.
export function ringOf(text) {
    const points = String(text ?? '').trim().split('\n')
        .map((line) => line.split(',').map((n) => Number(n.trim())))
        .filter((p) => p.length === 2 && p.every(Number.isFinite));
    if (points.length < 3) return null;
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
    return points;
}

// Who is waiting, and which of them this boundary is being drawn for.
function listRequests(host, state, redraw) {
    if (!state.open.length) {
        host.replaceChildren(empty('Nobody is waiting',
            'Requests for land appear here, with the words the asker wrote.'));
        return;
    }
    host.replaceChildren(...state.open.map((r) => {
        const row = el('button', { type: 'button', className: 'bare' },
            el('b', { textContent: r.who }),
            el('span', { className: 'muted', textContent: ` ${r.note}` }));
        row.setAttribute('aria-current', String(r.id === state.chosen));
        row.onclick = () => { state.chosen = r.id; redraw(); };
        return row;
    }));
}

// The land the map has picked, and what happens to it. Nothing until somebody
// clicks a piece of ground, because there is nothing to say about no land.
function showPicked(host, state, acts) {
    const a = state.all.find((x) => x.id === state.picked);
    if (!a) {
        host.replaceChildren(empty('No land picked',
            state.mode === 'pick'
                ? 'Click a piece of land on the map.'
                : 'Switch the map to Pick and click a piece of land.'));
        return;
    }
    const kids = [
        el('div', { className: 'name', textContent: a.rules?.name || 'unnamed' }),
        el('div', { className: 'sub',
            textContent: [a.owner, `detail ${a.detail}`,
                a.drawn === undefined ? null : `${a.drawn} drawn`,
                a.things === undefined ? null : `${a.things} placed`]
                .filter(Boolean).join(' · ') }),
    ];
    // Only an admin may delete land (db/0085), and only all_areas() says whose
    // it is — a player's own list has neither, so for them this is a card and
    // nothing to press.
    if (state.admin) {
        const drop = el('button', { type: 'button', className: 'land-drop',
            textContent: state.confirming === a.id ? 'Really delete' : 'Delete' });
        if (state.confirming === a.id) drop.dataset.arm = '1';
        drop.onclick = () => acts.remove(a);
        kids.push(drop);
    }
    host.replaceChildren(el('div', { className: 'picked-land' }, ...kids));
}

// Deleting land takes what stood on it with it and marks the ground changed
// (db/0085_landanadmincantakeback.sql), so it is asked for twice: the second
// press is the one that means it.
async function removeLand(area, state, say, refresh, draw) {
    const name = area.rules?.name || 'this land';
    if (state.confirming !== area.id) {
        state.confirming = area.id;
        say(`${name} — and everything drawn or placed on it. Press again.`, true);
        draw();
        return;
    }
    state.confirming = null;
    try {
        const done = await api.rpc('delete_area', { area_id: area.id });
        state.picked = null;
        say(`${done.name} is gone — ${done.tiles} tile(s) to build again`
            + `${done.jobs ? `, ${done.jobs} job(s) cancelled` : ''}.`);
    } catch (err) {
        say(String(err.body?.message ?? err.message ?? err), true);
    }
    await refresh();
}

// The strip over the map: which of its two jobs it is doing, and how far in it
// is looking. A coverage is tens of kilometres and the land on it is a few
// hundred metres, so there has to be a way in.
function mapControls() {
    const mode = el('div', { className: 'row lm-mode' });
    const buttons = new Map();
    for (const [key, label] of [['draw', 'Draw'], ['pick', 'Pick']]) {
        const b = el('button', { type: 'button', textContent: label });
        b.dataset.mode = key;
        buttons.set(key, b);
        mode.append(b);
    }
    const zoom = el('div', { className: 'row lm-zoom' });
    const zooms = new Map();
    for (const [key, label, title] of [['out', '−', 'zoom out'],
        ['in', '+', 'zoom in'], ['fit', 'Fit', 'the whole world']]) {
        const b = el('button', { type: 'button', textContent: label, title });
        b.dataset.zoom = key;
        zooms.set(key, b);
        zoom.append(b);
    }
    const scale = el('span', { className: 'lm-scale muted mono' });
    return { node: el('div', { className: 'spread lm-bar' }, mode, zoom, scale),
        buttons, zooms, scale };
}

// The panel, as the design lays it out: who is waiting, the map, what was
// drawn as numbers, and the name it will be called.
function build(host) {
    const canvas = el('canvas', { id: 'assign-map', width: MAP.w, height: MAP.h });
    const controls = mapControls();
    const requests = el('div', { className: 'rows assign-requests' });
    const boundary = el('textarea', { id: 'assign-boundary', rows: 5,
        placeholder: 'one "longitude, latitude" per line' });
    const nameField = el('input', { type: 'text', id: 'assign-name',
        placeholder: 'Ben’s field' });
    const finish = el('button', { type: 'button',
        textContent: 'Finish the boundary' });
    const clear = el('button', { type: 'button', textContent: 'Start again' });
    const assign = el('button', { type: 'button', className: 'primary',
        textContent: 'Assign this land' });
    const status = el('p', { className: 'status assign-status' });
    const picked = el('div', { className: 'picked' });
    const landStatus = el('p', { className: 'status land-drop-status' });
    host.append(el('div', { className: 'section assign' },
        el('span', { className: 'label', textContent: 'Land requests' }),
        requests,
        el('p', { className: 'muted',
            textContent: 'Drag the map to move it, + and − to go in and'
                + ' out. Draw puts corners down; Pick selects the land you'
                + ' click on.' }),
        controls.node, canvas,
        el('div', { className: 'row' }, finish, clear),
        el('label', { htmlFor: 'assign-boundary', textContent: 'boundary' }),
        boundary,
        el('label', { htmlFor: 'assign-name', textContent: 'name this land' }),
        nameField, assign, status));
    host.append(el('div', { className: 'section picked-box' },
        el('span', { className: 'label', textContent: 'The land you picked' }),
        picked, landStatus));

    return { canvas, controls, requests, boundary, nameField, finish, clear,
        assign, status, picked, landStatus };
}

// Where a pointer event lands on the map, in lon/lat.
function lonLatOf(canvas, state, event) {
    const box = canvas.getBoundingClientRect();
    return projection(state.view).toLonLat(
        (event.clientX - box.left) * (MAP.w / box.width),
        (event.clientY - box.top) * (MAP.h / box.height));
}

// Dragging moves the map; a press that goes nowhere is a click, and a click
// means whichever of the map's two jobs it is doing. Four pixels of slop,
// because a mouse moves a little while a button is going down.
function pointing(canvas, state, { redraw, pickAt, addCorner }) {
    let from = null;
    let moved = false;
    // Capture so a drag that leaves the canvas still moves the map — and
    // never at the cost of the press: a browser that refuses the capture is
    // not a reason for the map to stop working.
    const capture = (on, id) => {
        try { canvas[on ? 'setPointerCapture' : 'releasePointerCapture']?.(id); }
        catch { /* not captured, or not capturable */ }
    };
    canvas.onpointerdown = (event) => {
        from = { x: event.clientX, y: event.clientY, view: state.view };
        moved = false;
        capture(true, event.pointerId);
    };
    canvas.onpointermove = (event) => {
        if (!from) return;
        const dx = event.clientX - from.x;
        const dy = event.clientY - from.y;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        const box = canvas.getBoundingClientRect();
        const v = from.view;
        state.view = panned(v,
            -(dx / box.width) * (v.east - v.west),
            (dy / box.height) * (v.north - v.south), state.fit);
        redraw();
    };
    canvas.onpointerup = (event) => {
        const was = from;
        from = null;
        capture(false, event.pointerId);
        if (!was || moved) return;
        const at = lonLatOf(canvas, state, event);
        if (state.mode === 'pick') pickAt(at); else addCorner(at);
    };
    canvas.onpointercancel = () => { from = null; };
}

// How wide the map is, in the units a person thinks in.
const across = (view) => {
    const m = (view.east - view.west) * 111320
        * Math.cos((((view.north + view.south) / 2) * Math.PI) / 180);
    return m < 2000 ? `${Math.round(m)} m across`
        : `${(m / 1000).toFixed(1)} km across`;
};

export function mountAssignLand(host, { filesUrl = '' } = {}) {
    const ui = build(host);
    const state = { ground: null, all: [], corners: [], open: [], chosen: null,
        confirming: null, shade: null, shadeFor: null, cutAt: '', admin: false,
        mode: 'draw', picked: null, view: fitView(null), fit: fitView(null) };

    const say = saying(ui.status);
    const sayLand = saying(ui.landStatus);
    const drawRequests = () => listRequests(ui.requests, state, drawRequests);
    const acts = { remove: (area) => removeLand(area, state, sayLand, refresh, drawPicked) };
    const drawPicked = () => showPicked(ui.picked, state, acts);
    const paint = () => paintMap(ui.canvas,
        { ...state, areas: state.all, picked: state.picked });

    function redraw() {
        paint();
        for (const [key, b] of ui.controls.buttons) {
            b.dataset.on = state.mode === key ? '1' : '';
        }
        ui.controls.scale.textContent = across(state.view);
        loadShade();
    }
    const both = () => { redraw(); drawPicked(); };
    const look = (next) => { state.view = next; redraw(); };

    wire(ui, state, { redraw, both, look, say, sayLand, refresh });

    // The ground behind the map: one cut tile over whatever it is looking at
    // (client/lib/demshade.js). Keyed on that tile and not on the view, because
    // a drag moves the view on every pointer event and would otherwise ask the
    // store for the same rectangle sixty times a second. Going in far enough to
    // cross into a finer tile is what fetches finer ground.
    async function loadShade() {
        if (!state.ground) return;
        const t = tileOver(state.view);
        const key = `${t.z}/${t.x}/${t.y}`;
        if (key === state.shadeFor) return;
        state.shadeFor = key;
        const got = await groundOver(state.view,
            { filesUrl, version: state.cutAt ?? '' }).catch(() => null);
        if (state.shadeFor !== key) return;      // the view moved on meanwhile
        state.shade = got;
        paint();
    }

    async function refresh() {
        await reread(state);
        drawRequests();
        both();
        return state.open;
    }

    refresh();
    return { refresh, requests: () => state.open, land: () => state.all,
        view: () => state.view, pick: (id) => { state.picked = id; both(); } };
}

// The ground's shape, without the mark that says when it was last cut: the
// map is put back to the whole world when the world moves, not when the same
// world is cut again under an operator who is looking at one corner of it.
const shapeOf = (g) => JSON.stringify({ ...(g ?? {}), set_at: null });

// What the world says, into the state the panel draws from.
async function reread(state) {
    const ground = await api.rpc('ground').catch(() => null);
    if (shapeOf(ground) !== shapeOf(state.ground)) {
        state.fit = fitView(ground);
        state.view = state.fit;
    }
    // The ground was cut again (db/0154): the hillshade behind the map is of
    // the survey before it, so it goes and is asked for under the new mark.
    if ((ground?.set_at ?? '') !== (state.cutAt ?? '')) {
        state.cutAt = ground?.set_at ?? '';
        state.shade = null;
        state.shadeFor = null;
    }
    state.ground = ground;
    state.admin = api.role() === 'admin';
    // Every piece of land, not the admin's own: a boundary is drawn against
    // whose ground is already where (db/0085). A player gets their own from
    // the other call, and then this is the map it always was.
    const rows = state.admin
        ? await api.rpc('all_areas').catch(() => [])
        : await api.rpc('my_areas').catch(() => []);
    state.all = Array.isArray(rows) ? rows : [];
    if (!state.all.some((a) => a.id === state.picked)) state.picked = null;
    const asked = await api.rpc('land_requests', { which: 'open' }).catch(() => []);
    state.open = Array.isArray(asked) ? asked : [];
    state.chosen = state.open.find((r) => r.id === state.chosen)?.id
        ?? state.open[0]?.id ?? null;
}

// Every control on the panel: the map's two modes, the three zooms, the
// pointer, and the three buttons that end a boundary.
function wire(ui, state, { redraw, both, look, say, sayLand, refresh }) {
    ui.controls.buttons.get('draw').onclick = () => { state.mode = 'draw'; both(); };
    ui.controls.buttons.get('pick').onclick = () => { state.mode = 'pick'; both(); };
    ui.controls.zooms.get('in').onclick
        = () => look(zoomed(state.view, ZOOM_STEP, state.fit));
    ui.controls.zooms.get('out').onclick
        = () => look(zoomed(state.view, 1 / ZOOM_STEP, state.fit));
    ui.controls.zooms.get('fit').onclick = () => look(state.fit);

    pointing(ui.canvas, state, {
        redraw,
        pickAt: ([lon, lat]) => {
            const hit = areaAt(state.all, lon, lat);
            state.picked = hit?.id ?? null;
            state.confirming = null;
            sayLand(hit ? '' : 'No land there.', !hit);
            both();
        },
        addCorner: (at) => { state.corners.push(at); redraw(); },
    });

    ui.finish.onclick = () => {
        if (state.corners.length < 3) {
            say('Land needs at least three corners.', true);
            return;
        }
        ui.boundary.value = ringText(state.corners);
        say(`${state.corners.length} corners.`);
    };
    ui.clear.onclick = () => {
        state.corners = [];
        ui.boundary.value = '';
        redraw();
    };
    ui.assign.onclick = () => handOver(state, ui.boundary, ui.nameField, say, refresh);
}
