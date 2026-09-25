// shapeui.js — Build → Shape: the ground of one land, shaped on the Blueprint
// clay (PLAN-editors.md §2.2, EDT.6).
//
// Opening the surface is shaping: Blueprint opens over the chosen land
// (client/js/bpmode.js), the walk camera lets go, and the panel is the column
// beside the clay — the land, the rail, what the tool in hand reads, and what
// has been done. Closing the surface, or opening any other, closes Blueprint
// and hands the camera back.
//
// The brushes are client/js/sculptbrush.js, the grid client/js/sculpt.js, the
// pointer on the clay client/js/shapetool.js.

import * as api from './api.js';
import { Shaping, brushWords } from './sculpt.js';
import { alongLine } from './sculptbrush.js';
import { el } from './poolui.js';
import { brushLine, brushUses, earthLine, keyHandler, shapedLine } from './sculptmode.js';
import { floors, wireBox } from './shapebox.js';
import { mountHistory } from './shapehistory.js';
import { mountLeave, saveGround } from './shapesave.js';
import { restore } from './shapekeep.js';
import { toolRail } from './sculptrail.js';
import { shapeSurface } from './shapetool.js';

const HTML = `
<div class="section sh-head">
  <label class="sh-land-row"><span class="label">Land</span>
    <select class="sc-land"></select></label>
  <p class="mono sh-earth"></p>
</div>
<div class="sh-rail-host"></div>
<p class="sc-status status"></p>
<button type="button" class="sc-retry" hidden>Retry the save</button>
<div class="sh-history-host"></div>
<div class="section">
  <p class="muted sc-said"></p>
  <p class="note mono sc-shaped"></p>
  <p class="note">Nothing reaches the world until Save. What you shape is
    metres off the ground the operator's elevation gives, so a better elevation
    later keeps your shaping.</p>
</div>`;

// What the panel says about itself, in one line.
const sentence = (state) => {
    if (!state.shaping) return 'no land to shape';
    const n = state.shaping.strokes.length;
    return `${brushWords(state.brush)} · ${state.size} m · `
        + `${n} stroke${n === 1 ? '' : 's'} unsaved`;
};

/**
 * ctx: {bpmode, bp, app, pc, onSaved}; `lands()` answers the player's areas.
 */
export function mountShape(host, ctx, { lands = () => [] } = {}) {
    const node = el('div');
    node.innerHTML = HTML;
    host.append(node);
    const state = fresh();
    const rail = toolRail((id) => pick(id), node.querySelector('.sh-rail-host'));
    const q = (sel) => node.querySelector(sel);
    const say = (msg, bad = false) => {
        if (msg !== undefined) {
            q('.sc-status').textContent = msg;
            q('.sc-status').dataset.bad = bad ? '1' : '';
        }
        q('.sc-said').textContent = sentence(state);
        q('.sc-shaped').textContent = shapedLine(state.shaping);
        q('.sh-earth').textContent = earthLine(state.shaping);
        history.draw();
        hover();
    };
    const history = mountHistory(q('.sh-history-host'), { shaping: () => state.shaping,
        changed: (words) => { ctx.bp.rebuild(null); say(words); } });
    const hover = () => corners(q, state, ctx);
    const ground = (lon, lat) => ctx.bp.demAt(lon, lat) ?? 0;
    // While a stroke is on, the clay is rebuilt without its contours, which
    // are drawn again once it is let go of (client/js/blueprint.js quick).
    const surface = shapeSurface(ctx.bp, ctx.app, ctx.pc, state, { say, hover, ground,
        shaped: (rect) => ctx.bp.rebuild(rect, { quick: state.painting }),
        levelTo: () => state.target, turn: (deg) => fields.turn(deg),
        take: (g) => levelHere(state, say, fields, g) });
    const pick = (id) => pickBrush(rail, q, state, id, say);
    const open = () => openOver(ctx, state, surface, say);
    const load = (id) => chooseLand(q, state, say, id);
    const choose = async (id) => {
        await load(id);
        if (state.on) await open();
    };
    const acts = { choose, say, pick, ctx,
        save: () => saveGround(state, say, ctx, q('.sc-retry')),
        apply: () => layBed(q, state, say, ctx, ground),
        clear: () => history.confirm(() => putBack(state, say, ctx)),
        take: () => levelHere(state, say, fields) };
    const fields = wire(rail, q, state, acts);
    return {
        state, say, surface, ...acts,
        shaping: () => state.shaping,
        refresh: () => listLands(q, state, say, lands, load),
        ...comings(ctx, state, () => listLands(q, state, say, lands, load), open,
            { leave: mountLeave(document.getElementById('hud') ?? document.body),
                save: acts.save, surface }),
    };
}

// What the panel starts out holding.
const fresh = () => ({ on: false, brush: 'raise', size: 12, strength: 1, soft: 0.6,
    curve: 'smooth', shape: 'circle', blend: true, fall: 0, dir: 180, target: NaN,
    shaping: null, areas: [], roads: [], painting: false, at: null, inside: null, line: [] });

// The surface opened (the land's grid, then the clay over it) and left —
// asking first when there are strokes nobody has saved.
function comings(ctx, state, list, open, { leave, save, surface }) {
    return {
        async enter() {
            state.on = true;
            // The operator's switches, not the player's (PLAN-editors ideas
            // 13 and 16): the edge blend, and how far the ground may move.
            const set = await api.rpc('app_settings').catch(() => ({}));
            state.blend = set?.edge_blend !== 'off';
            state.limit = { up: Number(set?.shape_max_up) || 8,
                down: Number(set?.shape_max_down) || 8 };
            if (!state.shaping) await list();
            if (state.shaping && state.on) await open();
            return state.shaping;
        },
        async leave() {
            if (!state.on || state.asking) return;
            state.painting = false;
            const n = state.shaping?.strokes.length ?? 0;
            if (n) {
                state.asking = true;
                const answer = await leave.ask(`${n} stroke${n === 1 ? '' : 's'} on`
                    + ` ${state.shaping.area.rules?.name ?? 'this land'} not saved.`);
                state.asking = false;
                if (answer === 'stay') { ctx.reopen?.(); return; }
                if (answer === 'save') await save();
                else state.shaping.undoTo(0);
            }
            state.on = false;
            // Only the clay Shape opened: Lines may have it by now.
            if (ctx.bpmode.surface === surface) ctx.bpmode.close();
        },
    };
}

// How much of a line has been clicked out, and the words at the pointer.
function corners(q, state, ctx) {
    const n = (state.line ?? []).length;
    q('.sc-corners').textContent = n
        ? `${n} corner${n === 1 ? '' : 's'} clicked` : 'no corners yet';
    ctx.bpmode.say?.();
}

async function openOver(ctx, state, surface, say) {
    if (!state.shaping) return null;
    // Stay, after asking whether to leave: the clay is still open over it.
    if (ctx.bp.active && ctx.bpmode.surface === surface
        && ctx.bp.area?.id === state.shaping.area.id) return ctx.bp.openedMs;
    const ms = await ctx.bpmode.open(state.shaping.area, state.shaping, surface);
    say('shaping — drag on the ground');
    return ms;
}

async function listLands(q, state, say, lands, choose) {
    state.areas = (await lands()).filter((a) => a.may_write || a.may_propose);
    q('.sc-land').replaceChildren(...state.areas.map(
        (a) => new Option(a.rules?.name || 'unnamed land', a.id)));
    if (state.areas.length) await choose(state.areas[0].id);
    else say('No land of yours to shape — Land · 3.');
    return state.areas;
}

async function chooseLand(q, state, say, id) {
    const area = state.areas.find((a) => a.id === id);
    if (!area) return null;
    q('.sc-land').value = id;
    state.shaping = await Shaping.load(area);
    state.roads = await roadsOn(area);
    state.line = [];
    // What could not be saved last time, back as one stroke (EDT.10).
    const kept = await restore(state.shaping).catch(() => 0);
    q('.sc-retry').hidden = !kept;
    floors(q('.sc-floor'), await api.rpc('area_contents', { area_id: area.id }).catch(() => []));
    q('.sc-road').replaceChildren(new Option('pick a road…', ''),
        ...state.roads.map((r) => new Option(r.name, String(r.id))));
    say(kept ? `${kept.toLocaleString()} cells kept on this machine from a save that did`
        + ' not go through \u2014 Save to send them' : '');
    return state.shaping;
}

// The ground as the operator's elevation gave it: one stroke, undoable, and
// nothing anybody else sees until it is saved.
function putBack(state, say, ctx) {
    const moved = state.shaping?.clear() ?? 0;
    ctx.bp.rebuild(null);
    say(moved ? `${moved.toLocaleString()} cell(s) put back — Save to keep it`
        : 'this ground is already as the elevation gave it');
    return moved;
}

// What Level aims at, read off the clay rather than typed from nothing: where
// the pointer is, or where an Alt-click landed.
function levelHere(state, say, box, g = state.at) {
    const here = g?.h;
    if (!Number.isFinite(here)) { say('point at some ground first', true); return null; }
    box.aim(here);
    say(`levelling to ${here.toFixed(1)} m`);
    return here;
}

// The bed, written once so one undo takes the whole of it back.
function layBed(q, state, say, ctx, ground) {
    const road = state.roads.find((r) => String(r.id) === q('.sc-road').value);
    const points = road?.points ?? state.line;
    if (!points?.length) {
        say('pick a road, or click points along the path', true);
        return null;
    }
    const got = alongLine(state.shaping, points, {
        width: Number(q('.sc-width').value) || 7,
        shoulder: Number(q('.sc-shoulder').value) || 0,
        gradient: Number(q('.sc-gradient').value) || 8,
        ground,
    });
    ctx.bp.rebuild(null);
    say(`bed laid along ${got.metres.toFixed(0)} m · steepest `
        + `${got.steepest.toFixed(1)} %`);
    return got;
}

// Which tool is in hand: lit on the rail, named over the box, and only the
// fields it reads on screen.
function pickBrush(rail, q, state, id, say) {
    state.brush = id;
    rail.pick(id);
    for (const field of rail.all('.sc-fields [data-uses]')) {
        field.hidden = !brushUses(id, field.dataset.uses);
    }
    q('.sc-brush-says').textContent = brushLine(state);
    q('.sc-line-box').hidden = id !== 'line';
    say('');
}

function wire(rail, q, state, acts) {
    q('.sc-land').addEventListener('change', (e) => acts.choose(e.target.value));
    const box = wireBox(q, (sel) => rail.all(sel), state, () => acts.say(''));
    const { resize } = box;
    const redraw = () => acts.ctx.bp.rebuild(null);
    const undo = () => {
        acts.say(state.shaping?.undo() ? 'undone' : 'nothing to undo');
        redraw();
    };
    const redo = () => {
        acts.say(state.shaping?.redo() ? 'redone' : 'nothing to redo');
        redraw();
    };
    q('.sc-undo').onclick = undo;
    q('.sc-redo').onclick = redo;
    q('.sc-save').onclick = acts.save;
    q('.sc-retry').onclick = acts.save;
    q('.sc-apply').onclick = acts.apply;
    q('.sc-clear').onclick = acts.clear;
    q('.sc-take').onclick = acts.take;
    q('.sc-line-clear').onclick = () => {
        state.line = [];
        acts.say('the line is cleared — click its corners again');
    };
    document.addEventListener('keydown',
        keyHandler(state, { brush: acts.pick, size: resize, undo, redo }));
    acts.pick(state.brush);
    return box;
}

// The lines this land holds, so a bed can be laid along one without clicking
// it out by hand.
async function roadsOn(area) {
    const rows = await api.rpc('area_lines', { area: area.id }).catch(() => []);
    return (rows ?? []).map((r) => ({
        id: r.id,
        name: r.props?.name || `${r.props?.highway ?? 'road'} ${String(r.id).slice(0, 6)}`,
        points: pointsOf(r.geom),
    })).filter((r) => r.points.length > 1);
}

const pointsOf = (geom) => {
    const line = geom?.type === 'LineString' ? geom.coordinates
        : geom?.type === 'MultiLineString' ? geom.coordinates[0] : [];
    return (line ?? []).map(([lon, lat]) => ({ lon, lat }));
};
