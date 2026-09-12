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

function paint(canvas, ground, areas, corners) {
    const ctx = canvas.getContext('2d');
    const p = projection(ground);
    ctx.clearRect(0, 0, MAP.w, MAP.h);
    ctx.fillStyle = '#11151a';
    ctx.fillRect(0, 0, MAP.w, MAP.h);
    // The edge of the world, because land outside it cannot be made.
    ctx.strokeStyle = '#3b444d';
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(MAP.pad, MAP.pad, MAP.w - 2 * MAP.pad, MAP.h - 2 * MAP.pad);
    ctx.setLineDash([]);
    for (const area of areas ?? []) {
        const rings = area.outline?.type === 'MultiPolygon'
            ? area.outline.coordinates.flat() : (area.outline?.coordinates ?? []);
        ctx.strokeStyle = '#6d7780';
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
        host.replaceChildren(el('p', { className: 'muted',
            textContent: 'Nobody is waiting for land.' }));
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

    return { canvas, requests, boundary, nameField, finish, clear, assign, status };
}

export function mountAssignLand(host) {
    const { canvas, requests, boundary, nameField, finish, clear, assign, status }
        = build(host);
    const state = { ground: null, areas: [], corners: [], open: [], chosen: null };

    const say = (msg, bad = false) => {
        status.textContent = msg;
        status.dataset.bad = bad ? '1' : '';
    };

    const drawRequests = () => listRequests(requests, state, drawRequests);

    canvas.onclick = (event) => {
        const box = canvas.getBoundingClientRect();
        const p = projection(state.ground);
        state.corners.push(p.toLonLat(
            (event.clientX - box.left) * (MAP.w / box.width),
            (event.clientY - box.top) * (MAP.h / box.height)));
        paint(canvas, state.ground, state.areas, state.corners);
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
        paint(canvas, state.ground, state.areas, state.corners);
    };

    assign.onclick = () => handOver(state, boundary, nameField, say, refresh);

    async function refresh() {
        state.ground = await api.rpc('ground').catch(() => null);
        state.areas = await api.rpc('my_areas').catch(() => []);
        const rows = await api.rpc('land_requests', { which: 'open' })
            .catch(() => []);
        state.open = Array.isArray(rows) ? rows : [];
        state.chosen = state.open.find((r) => r.id === state.chosen)?.id
            ?? state.open[0]?.id ?? null;
        drawRequests();
        paint(canvas, state.ground, state.areas, state.corners);
        return state.open;
    }

    refresh();
    return { refresh, requests: () => state.open };
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
