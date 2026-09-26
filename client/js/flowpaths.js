// flowpaths.js — Automate › Paths: a product on a route over your land
// (TASKS-ui.md UI.8), the minimal version of the drawer.
//
// The land is drawn from above as its outline; clicking on it puts down the
// route's corners, one after another. A product, a speed and how often it
// comes round, and it is a mover — the same row Build › Place › Movers makes
// (moversui.js, db/0171), so both places list the same ones.

import { el } from './poolui.js';
import { searchAssets } from './catalog.js';
import { moversOn, setMover } from './movers.js';
import { scheduleOf } from './moversui.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
};
const K = 1e5;

// The land's own frame: longitude shrunk by the cosine of its latitude, so a
// square field is drawn square.
export function frameOf(bbox) {
    const cos = Math.cos(((bbox.north + bbox.south) / 2) * Math.PI / 180);
    const w = (bbox.east - bbox.west) * cos * K;
    const h = (bbox.north - bbox.south) * K;
    const pad = Math.max(w, h) * 0.08;
    return {
        box: `${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`,
        xy: ([lon, lat]) => [(lon - bbox.west) * cos * K, (bbox.north - lat) * K],
        lonlat: ([x, y]) => [bbox.west + x / (cos * K), bbox.north - y / K],
    };
}

const ringsOf = (g) => (g?.type === 'MultiPolygon' ? g.coordinates.flat()
    : g?.type === 'Polygon' ? g.coordinates : []);

function field(label, input) {
    input.setAttribute('aria-label', label);
    return el('label', { className: 'fp-field' }, el('span', { textContent: label }), input);
}

function formParts() {
    return {
        land: el('select', { className: 'fp-land' }),
        search: el('input', { type: 'search', className: 'fp-search',
            placeholder: 'Bus, tram, boat…' }),
        found: el('ul', { className: 'fp-found' }),
        name: el('input', { type: 'text', className: 'fp-name' }),
        speed: el('input', { type: 'number', min: '1', value: '30', className: 'fp-speed' }),
        every: el('input', { type: 'number', min: '1', value: '5', className: 'fp-every' }),
        back: el('input', { type: 'checkbox', className: 'fp-back' }),
        clear: el('button', { type: 'button', className: 'fp-clear', textContent: 'Clear' }),
        make: el('button', { type: 'button', className: 'primary fp-make',
            textContent: 'Put it on the route' }),
        said: el('p', { className: 'fp-said muted' }),
        list: el('ul', { className: 'fp-movers fl-list' }),
    };
}

// The map: outline, route, corners — redrawn whole on every change.
function drawMap(map, state) {
    const land = state.lands.find((a) => a.id === state.area);
    map.replaceChildren();
    if (!land?.bbox) return;
    const f = frameOf(land.bbox);
    state.frame = f;
    map.setAttribute('viewBox', f.box);
    for (const ring of ringsOf(land.outline)) {
        map.append(svg('polygon', { class: 'fp-outline',
            points: ring.map((p) => f.xy(p).join(',')).join(' ') }));
    }
    for (const m of state.movers) {
        map.append(svg('polyline', { class: 'fp-other',
            points: (m.route?.coordinates ?? []).map((p) => f.xy(p).join(',')).join(' ') }));
    }
    const pts = state.corners.map((p) => f.xy(p));
    map.append(svg('polyline', { class: 'fp-route',
        points: pts.map((p) => p.join(',')).join(' ') }));
    const r = Math.max(1, Number(f.box.split(' ')[2]) / 120);
    for (const [x, y] of pts) map.append(svg('circle', { class: 'fp-corner', cx: x, cy: y, r }));
}

export function mountPaths(host, { lands }) {
    const p = formParts();
    const map = svg('svg', { class: 'fp-map', role: 'img', 'aria-label': 'the land from above' });
    const state = { lands: [], area: null, corners: [], brush: null, movers: [], frame: null };
    const say = (t, bad = false) => {
        p.said.textContent = t;
        p.said.dataset.bad = bad ? '1' : '';
    };
    const words = () => `${state.corners.length} corner(s)`
        + ` · ${state.brush?.name ?? 'no product yet'}`;
    host.append(
        el('aside', { className: 'fp-side' },
            el('h3', { textContent: 'A route over your land' }),
            el('p', { className: 'muted', textContent: 'Click the corners on the map; pick what'
                + ' drives it and how often it comes round.' }),
            field('Land', p.land), field('What moves', p.search), p.found,
            field('Name', p.name),
            el('div', { className: 'row' }, field('km/h', p.speed), field('Every (min)', p.every)),
            el('label', { className: 'fp-check' }, p.back, 'Back and forth'),
            el('div', { className: 'row' }, p.clear, p.make), p.said,
            el('h3', { textContent: 'On this land' }), p.list),
        el('div', { className: 'fp-draw' }, map));

    async function refresh() {
        state.lands = (await lands()).filter((a) => a.may_write !== false);
        p.land.replaceChildren(...state.lands.map((a) => new Option(a.name, a.id)));
        if (!state.lands.some((a) => a.id === state.area)) state.area = state.lands[0]?.id ?? null;
        p.land.value = state.area ?? '';
        state.movers = state.area ? await moversOn(state.area).catch(() => []) : [];
        p.list.replaceChildren(...state.movers.map((m) => el('li', { className: 'fp-mover',
            textContent: `${m.name || 'a mover'} · ${Number(m.speed_kmh)} km/h · every`
                + ` ${Math.round((m.schedule?.every_s ?? 600) / 60)} min` })));
        if (!state.lands.length) say('You build on no land yet, so there is nowhere to drive.');
        drawMap(map, state);
        return state.movers;
    }
    wire(p, map, state, { say, words, refresh, redraw: () => drawMap(map, state) });
    return { refresh, state, map };
}

function wire(p, map, state, { say, words, refresh, redraw }) {
    p.land.onchange = () => { state.area = p.land.value; state.corners = []; refresh(); };
    map.addEventListener('click', (e) => {
        if (!state.frame) return;
        const at = new window.DOMPoint(e.clientX, e.clientY)
            .matrixTransform(map.getScreenCTM().inverse());
        state.corners.push(state.frame.lonlat([at.x, at.y]));
        redraw();
        say(words());
    });
    p.clear.onclick = () => { state.corners = []; redraw(); say(words()); };
    p.search.onchange = async () => {
        const rows = await searchAssets({ search: p.search.value, type: 'model', limit: 6 })
            .catch(() => []);
        p.found.replaceChildren(...rows.map((a) => {
            const b = el('button', { type: 'button', textContent: a.name });
            b.onclick = () => { state.brush = a; p.name.value ||= a.name; say(words()); };
            return el('li', {}, b);
        }));
    };
    p.make.onclick = async () => {
        if (!state.brush) { say('pick what moves first', true); return; }
        if (state.corners.length < 2) { say('click at least two corners first', true); return; }
        try {
            const done = await setMover(null, { area: state.area, san: state.brush.san,
                name: p.name.value.trim() || state.brush.name,
                route: { type: 'LineString', coordinates: state.corners },
                speed_kmh: Number(p.speed.value) || 30,
                schedule: scheduleOf({ every: p.every.value, back: p.back.checked }) });
            state.corners = [];
            await refresh();
            say(`${done.name || 'it'} is on the route`);
        } catch (err) {
            say(String(err.body?.message ?? err.message ?? err), true);
        }
    };
}
