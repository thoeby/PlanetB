// assignland.js — the admin's half of SPEC §3.2: who asked for land, and
// drawing them some.
//
// The map is the world's own ground extent with the land already in it, drawn
// on a canvas. There is no basemap service to put under it (Invariant 10) and
// the ortho pyramid is not seeded in a fresh world, so what it shows is what
// the world knows: where the coverage reaches, and whose ground is where.
//
// What is drawn goes into the boundary field as numbers, and the boundary
// field is what is sent — so an admin can correct a corner by typing, and the
// database still refuses anything outside the ground (db/0062).

import * as api from './api.js';
import { empty } from './empty.js';
import { groundOver, shadeRect } from '../lib/demshade.js';

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

const MAP = { w: 420, h: 300, pad: 12 };

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

function projection(ground) {
    const west = ground?.west ?? -180;
    const east = ground?.east ?? 180;
    const south = ground?.south ?? -85;
    const north = ground?.north ?? 85;
    const sx = (MAP.w - 2 * MAP.pad) / ((east - west) || 1);
    const sy = (MAP.h - 2 * MAP.pad) / ((north - south) || 1);
    return {
        toPx: (lon, lat) => [MAP.pad + (lon - west) * sx,
            MAP.pad + (north - lat) * sy],
        toLonLat: (x, y) => [west + (x - MAP.pad) / sx,
            north - (y - MAP.pad) / sy],
    };
}

function paint(canvas, ground, areas, corners, shade = null) {
    const ctx = canvas.getContext('2d');
    const p = projection(ground);
    ctx.clearRect(0, 0, MAP.w, MAP.h);
    ctx.fillStyle = '#11151a';
    ctx.fillRect(0, 0, MAP.w, MAP.h);
    // The land itself, behind everything else. Without it this was outlines
    // floating in a dark box: nothing said which way the valley ran, so a
    // boundary could only be drawn against other boundaries.
    if (ground) {
        shadeRect(ctx, shade, {
            west: ground.west, south: ground.south,
            east: ground.east, north: ground.north,
            x0: MAP.pad, y0: MAP.pad,
            w: MAP.w - 2 * MAP.pad, h: MAP.h - 2 * MAP.pad,
        });
    }
    // The edge of the world, because land outside it cannot be made.
    ctx.strokeStyle = '#3b444d';
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(MAP.pad, MAP.pad, MAP.w - 2 * MAP.pad, MAP.h - 2 * MAP.pad);
    ctx.setLineDash([]);
    for (const area of areas ?? []) {
        const rings = area.outline?.type === 'MultiPolygon'
            ? area.outline.coordinates.flat() : (area.outline?.coordinates ?? []);
        ctx.strokeStyle = area.picked ? '#e8b45f' : '#cdd5dd';
        ctx.lineWidth = area.picked ? 2 : 1;
        for (const ring of rings) {
            ctx.beginPath();
            ring.forEach(([lon, lat], i) => {
                const [x, y] = p.toPx(lon, lat);
                if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
            });
            ctx.closePath();
            ctx.stroke();
        }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#5fd8e8';
    ctx.fillStyle = '#5fd8e8';
    ctx.beginPath();
    corners.forEach(([lon, lat], i) => {
        const [x, y] = p.toPx(lon, lat);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        ctx.fillRect(x - 2, y - 2, 4, 4);
    });
    if (corners.length > 2) ctx.closePath();
    ctx.stroke();
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

// Every piece of land there is, and the button that takes one back. Land could
// only ever be made until db/0085: a boundary drawn in the wrong place, or
// given to the wrong person, was a row nothing could reach.
function listLand(host, state, acts) {
    if (!state.all.length) {
        host.replaceChildren(empty('No land yet',
            'Land drawn in QGIS, or assigned above, is listed here.'));
        return;
    }
    host.replaceChildren(...state.all.map((a) => {
        const name = a.rules?.name || 'unnamed';
        // Only an admin may delete land (db/0085), and only all_areas() says
        // whose it is and what is on it — a player's own list has neither, so
        // this is their land as it always was, with nothing to press.
        const drop = state.admin && el('button', { type: 'button',
            className: 'land-drop', textContent: 'Delete' });
        if (drop) {
            drop.onclick = (event) => { event.stopPropagation(); acts.remove(a, drop); };
        }
        const row = el('li', { className: 'admin-land' },
            el('div', { className: 'who' },
                el('div', { className: 'name', textContent: name }),
                el('div', { className: 'sub',
                    textContent: [a.owner, `detail ${a.detail}`,
                        a.drawn === undefined ? null : `${a.drawn} drawn`,
                        a.things === undefined ? null : `${a.things} placed`]
                        .filter(Boolean).join(' \u00b7 ') })),
            drop || null);
        row.onmouseenter = () => acts.highlight(a.id);
        row.onmouseleave = () => acts.highlight(null);
        return row;
    }));
}

// Deleting land takes what stood on it with it and marks the ground changed
// (db/0085_landanadmincantakeback.sql), so it is asked for twice: the second
// press is the one that means it.
async function removeLand(area, button, state, say, refresh) {
    const name = area.rules?.name || 'this land';
    if (state.confirming !== area.id) {
        state.confirming = area.id;
        button.textContent = 'Really delete';
        button.dataset.arm = '1';
        say(`${name} — and everything drawn or placed on it. Press again.`, true);
        return;
    }
    state.confirming = null;
    button.disabled = true;
    try {
        const done = await api.rpc('delete_area', { area_id: area.id });
        say(`${done.name} is gone \u2014 ${done.tiles} tile(s) to build again`
            + `${done.jobs ? `, ${done.jobs} job(s) cancelled` : ''}.`);
    } catch (err) {
        say(String(err.body?.message ?? err.message ?? err), true);
    }
    await refresh();
}

// The panel, as the design lays it out: who is waiting, the map, what was
// drawn as numbers, and the name it will be called.
function build(host) {
    const canvas = el('canvas', { id: 'assign-map', width: MAP.w, height: MAP.h });
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
    const all = el('ul', { className: 'rows admin-lands' });
    const landStatus = el('p', { className: 'status land-drop-status' });
    host.append(el('div', { className: 'section assign' },
        el('span', { className: 'label', textContent: 'Land requests' }),
        requests,
        el('p', { className: 'muted',
            textContent: 'Click the map to put corners down, then finish the'
                + ' boundary and give the land a name.' }),
        canvas,
        el('div', { className: 'row' }, finish, clear),
        el('label', { htmlFor: 'assign-boundary', textContent: 'boundary' }),
        boundary,
        el('label', { htmlFor: 'assign-name', textContent: 'name this land' }),
        nameField, assign, status));
    // Beside it on a wide panel, under it on a narrow one: every piece of land
    // there is, which is also what the map above is drawing.
    host.append(el('div', { className: 'section admin-land-list' },
        el('span', { className: 'label', textContent: 'Every piece of land' }),
        el('div', { className: 'note' },
            'Deleting land marks the ground it covered changed and takes what'
            + ' was drawn or placed on it with it. The tiles already compiled'
            + ' from it are kept — they are immutable — but the next compile'
            + ' of that ground will not have it.'),
        all, landStatus));

    return { canvas, requests, boundary, nameField, finish, clear, assign, status,
        all, landStatus };
}

export function mountAssignLand(host, { filesUrl = '' } = {}) {
    const { canvas, requests, boundary, nameField, finish, clear, assign, status,
        all, landStatus } = build(host);
    const state = { ground: null, all: [], corners: [], open: [],
        chosen: null, confirming: null, shade: null, shadeFor: null,
        admin: false };

    const say = saying(status);
    const sayLand = saying(landStatus);

    const drawRequests = () => listRequests(requests, state, drawRequests);
    const redraw = () => paint(canvas, state.ground, state.all, state.corners,
        state.shade);

    const acts = {
        remove: (area, button) => removeLand(area, button, state, sayLand, refresh),
        highlight(id) {
            for (const a of state.all) a.picked = a.id === id;
            redraw();
        },
    };
    const drawLand = () => listLand(all, state, acts);

    drawing({ canvas, finish, clear, state, boundary, say, redraw });
    assign.onclick = () => handOver(state, boundary, nameField, say, refresh);

    // The ground behind the map, fetched once per coverage: one cut tile over
    // the whole extent, and arithmetic after that (client/lib/demshade.js).
    async function loadShade() {
        const g = state.ground;
        const key = g && `${g.west},${g.south},${g.east},${g.north}`;
        if (!key || key === state.shadeFor) return;
        state.shadeFor = key;
        state.shade = await groundOver(g, { filesUrl }).catch(() => null);
        redraw();
    }

    async function refresh() {
        state.ground = await api.rpc('ground').catch(() => null);
        // Every piece of land, not the admin's own: a boundary is drawn against
        // whose ground is already where (db/0085). A player gets an empty list
        // from the same call, and then this is the map it always was.
        state.admin = api.role() === 'admin';
        const rows = state.admin
            ? await api.rpc('all_areas').catch(() => [])
            : await api.rpc('my_areas').catch(() => []);
        state.all = Array.isArray(rows) ? rows : [];
        const asked = await api.rpc('land_requests', { which: 'open' })
            .catch(() => []);
        state.open = Array.isArray(asked) ? asked : [];
        state.chosen = state.open.find((r) => r.id === state.chosen)?.id
            ?? state.open[0]?.id ?? null;
        drawRequests();
        drawLand();
        redraw();
        loadShade();
        return state.open;
    }

    refresh();
    return { refresh, requests: () => state.open, land: () => state.all };
}

const saying = (node) => (msg, bad = false) => {
    node.textContent = msg;
    node.dataset.bad = bad ? '1' : '';
};

// Putting corners on the map, and the two buttons that end a boundary.
function drawing({ canvas, finish, clear, state, boundary, say, redraw }) {
    canvas.onclick = (event) => {
        const box = canvas.getBoundingClientRect();
        const p = projection(state.ground);
        state.corners.push(p.toLonLat(
            (event.clientX - box.left) * (MAP.w / box.width),
            (event.clientY - box.top) * (MAP.h / box.height)));
        redraw();
    };
    finish.onclick = () => {
        if (state.corners.length < 3) {
            say('Land needs at least three corners.', true);
            return;
        }
        boundary.value = ringText(state.corners);
        say(`${state.corners.length} corners.`);
    };
    clear.onclick = () => {
        state.corners = [];
        boundary.value = '';
        redraw();
    };
}

// Invariant 6: what may be assigned, to whom, and whether it is even in this
// world is the database's to say — and what it says goes on the screen.
async function handOver(state, boundary, nameField, say, refresh) {
    if (!state.chosen) { say('Nobody is waiting for land.', true); return; }
    const ring = ringOf(boundary.value);
    if (!ring) { say('Put at least three corners on the map first.', true); return; }
    try {
        const done = await api.rpc('assign_land', {
            request_id: state.chosen,
            geojson: { type: 'Polygon', coordinates: [ring] },
            name: nameField.value,
        });
        say(`${done.name} assigned to ${done.who}.`);
        state.corners = [];
        boundary.value = '';
        await refresh();
    } catch (err) {
        say(String(err.body?.message ?? err.message ?? err), true);
    }
}
