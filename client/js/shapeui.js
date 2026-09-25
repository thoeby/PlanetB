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
import { brushLine, brushUses, keyHandler, shapedLine } from './sculptmode.js';
import { wireBox } from './shapebox.js';
import { toolRail } from './sculptrail.js';
import { shapeSurface } from './shapetool.js';

const HTML = `
<div class="section sh-head">
  <label class="sh-land-row"><span class="label">Land</span>
    <select class="sc-land"></select></label>
</div>
<div class="sh-rail-host"></div>
<p class="sc-status status"></p>
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
    const box = el('div');
    box.innerHTML = HTML;
    host.append(box);
    const state = { on: false, brush: 'raise', size: 12, strength: 1, soft: 0.6,
        curve: 'smooth', shape: 'circle', blend: true, shaping: null,
        areas: [], roads: [], painting: false, at: null, inside: null, line: [] };
    const rail = toolRail((id) => pick(id), box.querySelector('.sh-rail-host'));
    const q = (sel) => box.querySelector(sel);
    const say = (msg, bad = false) => {
        if (msg !== undefined) {
            q('.sc-status').textContent = msg;
            q('.sc-status').dataset.bad = bad ? '1' : '';
        }
        q('.sc-said').textContent = sentence(state);
        q('.sc-shaped').textContent = shapedLine(state.shaping);
        hover();
    };
    const hover = () => corners(q, state, ctx);
    const ground = (lon, lat) => ctx.bp.demAt(lon, lat) ?? 0;
    // While a stroke is on, the clay is rebuilt without its contours, which
    // are drawn again once it is let go of (client/js/blueprint.js quick).
    const shaped = (rect) => ctx.bp.rebuild(rect, { quick: state.painting });
    const surface = shapeSurface(ctx.bp, ctx.app, ctx.pc, state, { say, hover, shaped, ground,
        levelTo: () => Number(q('.sc-target').value) });
    const pick = (id) => pickBrush(rail, q, state, id, say);
    const open = () => openOver(ctx, state, surface, say);
    const load = (id) => chooseLand(q, state, say, id);
    const choose = async (id) => {
        await load(id);
        if (state.on) await open();
    };
    const acts = { choose, say, pick, ctx,
        save: () => saveGround(state, say, ctx),
        apply: () => layBed(q, state, say, ctx, ground),
        clear: () => putBack(state, say, ctx),
        take: () => levelHere(q, state, say, ground) };
    wire(rail, q, state, acts);
    return {
        state, say, surface, ...acts,
        shaping: () => state.shaping,
        refresh: () => listLands(q, state, say, lands, load),
        // The surface was opened: the land's grid, then the clay over it.
        async enter() {
            state.on = true;
            // The operator's switch, not the player's (PLAN-editors idea 13).
            const set = await api.rpc('app_settings').catch(() => ({}));
            state.blend = set?.edge_blend !== 'off';
            if (!state.shaping) await listLands(q, state, say, lands, load);
            if (state.shaping && state.on) await open();
            return state.shaping;
        },
        leave() {
            if (!state.on) return;
            state.on = false;
            state.painting = false;
            ctx.bpmode.close();
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
    q('.sc-road').replaceChildren(new Option('pick a road…', ''),
        ...state.roads.map((r) => new Option(r.name, String(r.id))));
    say('');
    return state.shaping;
}

async function saveGround(state, say, ctx) {
    if (!state.shaping?.dirty) { say('nothing shaped yet'); return null; }
    try {
        const got = await state.shaping.save();
        say(`ground saved · ${got.tiles} tile(s) changed`);
        ctx.bp.rebuild(null);
        ctx.onSaved?.();
        return got;
    } catch (err) {
        say(String(err.body?.message ?? err.message ?? err), true);
        return null;
    }
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

// What Level aims at, read off the ground rather than typed from nothing.
function levelHere(q, state, say, ground) {
    const at = state.at;
    const dem = at ? ground(at.lon, at.lat) : null;
    if (!Number.isFinite(dem)) { say('point at some ground first', true); return null; }
    const here = dem + (state.shaping?.at(at.lon, at.lat) ?? 0);
    q('.sc-target').value = here.toFixed(1);
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
    const { resize } = wireBox(q, (sel) => rail.all(sel), state, () => acts.say(''));
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
