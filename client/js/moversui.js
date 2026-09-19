// moversui.js — the Movers part of the Place panel (FND.16).
//
// A bus is a product, a line, a speed and a timetable. The line is drawn on
// the ground the way a boundary is: press Draw, click the corners, press it
// again. Nothing here is submitted and nothing is compiled — a mover is not on
// the land, it moves over it (db/0171).

import { el } from './poolui.js';
import { searchAssets } from './catalog.js';
import { dropMover, moversOn, setMover } from './movers.js';

const MIN_S = 60;

// The timetable, out of the four numbers the panel asks for.
export function scheduleOf({ every, stopAt, stopFor, back }) {
    const out = { every_s: Math.max(1, Math.round((Number(every) || 5) * MIN_S)),
        loop: back ? 'back_and_forth' : 'circle' };
    if (Number(stopFor) > 0) {
        out.dwell = [{ at_m: Math.max(0, Number(stopAt) || 0),
            s: Number(stopFor) }];
    }
    return out;
}

// How long until it comes round again, from the world's own clock: the one
// thing on this list that two players standing at the same stop compare.
export function nextIn(row, t) {
    const every = Math.max(1, Number(row.schedule?.every_s) || 600);
    const into = (((Number(t) || 0) + (Number(row.phase_s) || 0)) % every + every) % every;
    return Math.round(every - into);
}

const words = (row, t) => {
    const every = Math.round((row.schedule?.every_s ?? 600) / MIN_S);
    const stops = (row.schedule?.dwell ?? []).length;
    return `${row.name || 'a mover'} · ${Number(row.speed_kmh)} km/h · every ${every} min`
        + `${stops ? ` · ${stops} stop${stops === 1 ? '' : 's'}` : ''}`
        + `${row.paused ? ' · paused' : ` · next in ${nextIn(row, t)} s`}`;
};

// Pausing one and taking one off the land: the two things you do to a mover
// that is already running.
function doing(say, refresh) {
    const after = (fn, said) => async (entry) => {
        try {
            await fn(entry);
            say(said(entry));
        } catch (err) {
            say(String(err.body?.message ?? err.message ?? err), true);
        }
        await refresh();
    };
    return {
        pause: after((e) => setMover(e.id, { paused: !e.paused }),
            (e) => (e.paused ? 'running again' : 'stopped where it is')),
        drop: after((e) => dropMover(e.id), () => 'taken off the land'),
    };
}

// The products a mover could be, by name.
async function finder(q, state, say) {
    const rows = await searchAssets({ search: q('.mv-search').value,
        type: 'model', limit: 6 }).catch(() => []);
    q('.mv-found').replaceChildren(...rows.map((a) => {
        const b = el('button', { type: 'button', textContent: a.name });
        b.onclick = () => { state.brush = a; say(`${a.name} it is`); };
        return el('li', { className: 'mv-found-one' }, b);
    }));
}

// Putting one on the route: everything the panel asks for, in one call, which
// the database then holds to the land (db/0172).
function maker(q, state, say, refresh) {
    return async () => {
        if (!state.area) { say('stand on land you build on first', true); return null; }
        if (!state.brush) { say('pick a product for it first', true); return null; }
        if (state.corners.length < 2) { say('draw the route first', true); return null; }
        try {
            const done = await setMover(null, {
                area: state.area, san: state.brush.san,
                name: q('.mv-name').value.trim() || state.brush.name,
                route: { type: 'LineString', coordinates: state.corners },
                speed_kmh: Number(q('.mv-speed').value) || 30,
                schedule: scheduleOf({ every: q('.mv-every').value,
                    stopAt: q('.mv-stop-at').value, stopFor: q('.mv-stop-s').value,
                    back: q('.mv-back').checked }),
            });
            state.corners = [];
            await refresh();
            say(`${done.name || 'it'} is on the route`);
            return done;
        } catch (err) {
            say(String(err.body?.message ?? err.message ?? err), true);
            return null;
        }
    };
}

// The countdown counts down: a readout that only changed when the panel was
// refreshed would not be one.
function counting(q, state, clock) {
    return () => {
        const t = clock();
        for (const li of q('.mv-list').children) {
            const entry = state.rows.find((e) => e.id === li.dataset.mover);
            if (entry) li.querySelector('.mv-words').textContent = words(entry, t);
        }
    };
}

function row(entry, acts, t) {
    const li = el('li', { className: 'mv-one' });
    li.dataset.mover = entry.id;
    const hold = el('button', { type: 'button', className: 'mv-pause',
        textContent: entry.paused ? 'Resume' : 'Pause' });
    hold.onclick = () => acts.pause(entry);
    const gone = el('button', { type: 'button', className: 'mv-del',
        textContent: 'Delete' });
    gone.onclick = () => acts.drop(entry);
    li.append(el('span', { className: 'mv-words', textContent: words(entry, t) }),
        hold, gone);
    return li;
}

export function mountMovers(host, { clock = () => Date.now() / 1000 } = {}) {
    const q = (sel) => host.querySelector(sel);
    const state = { area: null, rows: [], drawing: false, corners: [], brush: null };
    const say = (text, bad = false) => {
        q('.mv-said').textContent = text;
        q('.mv-said').dataset.bad = bad ? '1' : '';
    };

    const drawn = () => {
        q('.mv-route').textContent = state.corners.length
            ? `${state.corners.length} corner(s)` : 'nothing drawn yet';
        q('.mv-draw').textContent = state.drawing ? 'Done' : 'Draw the route';
    };

    const acts = doing(say, () => refresh());

    async function refresh(area = state.area) {
        state.area = area ?? null;
        state.rows = state.area ? await moversOn(state.area).catch(() => []) : [];
        const t = clock();
        q('.mv-list').replaceChildren(...state.rows.map((e) => row(e, acts, t)));
        drawn();
        return state.rows;
    }

    const tick = counting(q, state, clock);
    const ticking = setInterval(tick, 1000);

    const make = maker(q, state, say, () => refresh());

    q('.mv-search').onchange = () => finder(q, state, say);
    q('.mv-make').onclick = make;
    q('.mv-draw').onclick = () => {
        state.drawing = !state.drawing;
        if (state.drawing) { state.corners = []; say('click the corners of the route'); }
        else say(`${state.corners.length} corner(s) drawn`);
        drawn();
    };

    return {
        node: q('.build-movers-section'), refresh, make, acts, state, tick,
        stop: () => clearInterval(ticking),
        drawing: () => state.drawing,
        // A click on the ground while the route is being drawn is a corner of
        // it, and not a thing being placed (client/js/buildui.js).
        corner(at) {
            if (!at) {
                say('that is not ground — click nearer', true);
                return state.corners.length;
            }
            state.corners.push([at.lon, at.lat]);
            drawn();
            say(`${state.corners.length} corner(s) drawn`);
            return state.corners.length;
        },
        said: () => q('.mv-said').textContent,
    };
}
