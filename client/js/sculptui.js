// sculptui.js — Land → Shape: the ground, shaped in the page.
//
// FND.9. The brushes and what they do are client/js/sculptbrush.js; what they
// write is client/js/sculpt.js's grid. This is the panel and the pointer: the
// same arrangement the Place panel has, because it is the same thing — a mode
// the 3D view is in while the panel is open.
//
// A stroke outside the land changes nothing and says so. That is a courtesy,
// not the rule: the rule is row-level security on the save (Invariant 6) and
// the compiler ignoring every cell outside the land whatever was written.

import * as api from './api.js';
import { Shaping, brushWords } from './sculpt.js';
import { alongLine, dab } from './sculptbrush.js';
import { el } from './poolui.js';
import { rayThrough } from './buildui.js';
import { raycastGround } from './build.js';
import { brushLine, brushUses, drawBrush, groundLine, keyHandler, shapedLine }
    from './sculptmode.js';
import { panning } from './sculptpan.js';
import { toolRail } from './sculptrail.js';

const HTML = `
<div class="section">
  <div class="row">
    <label class="sc-on-box"><input type="checkbox" class="sc-toggle"> Shape this land</label>
    <select class="sc-land"></select>
  </div>
  <div class="note">The tools are on the rail beside the world, and what the
    one in hand needs is in the box under it. What you shape is metres off the
    ground the operator's elevation says is there, so a better elevation later
    keeps your shaping.</div>
  <p class="muted sc-keys">H hand · R F S G L B brushes · [ ] resize
    · Ctrl-Z undo</p>
</div>
<div class="section">
  <div class="row">
    <button type="button" class="sc-undo">Undo</button>
    <button type="button" class="sc-redo">Redo</button>
    <button type="button" class="sc-save primary">Save</button>
  </div>
  <p class="sc-status status"></p>
  <p class="muted sc-said"></p>
  <p class="note mono sc-shaped"></p>
  <div class="spread sc-clear-box">
    <button type="button" class="sc-clear">Put the ground back</button>
    <span class="note">As the operator's elevation gave it. Undo takes it
      back, and nothing reaches the world until Save.</span>
  </div>
</div>`;

// Shaping on or off: who has the pointer, and what the world shows.
//
// FND.9: what is being shaped is the mesh, so while shaping is on the splats
// over that land come off and the mesh is what is on screen — you cannot shape
// ground you cannot see (client/js/tiles.js hideUnder).
function shapeMode(ctx, state, rail, q, paint, say, on) {
    state.on = on ?? !state.on;
    q('.sc-toggle').checked = state.on;
    rail.node.dataset.on = state.on ? '1' : '';
    for (const [name, fn] of paint.on) {
        if (state.on) ctx.canvas.addEventListener(name, fn, { passive: false });
        else ctx.canvas.removeEventListener(name, fn);
    }
    if (state.on) {
        ctx.player.detach();
        document.exitPointerLock?.();
    } else {
        ctx.player.attach(ctx.canvas);
    }
    ctx.onMode?.(state.on);
    say(state.on ? 'shaping \u2014 drag on the ground' : '');
    return state.on;
}

// What the panel says about itself, in one line.
const sentence = (state) => {
    if (!state.shaping) return 'no land to shape';
    const n = state.shaping.strokes.length;
    return `${brushWords(state.brush)} · ${state.size} m · `
        + `${n} stroke${n === 1 ? '' : 's'} unsaved`;
};

export function mountSculpt(host, ctx, { lands = () => [] } = {}) {
    const box = el('div');
    box.innerHTML = HTML;
    host.append(box);
    // The tools are over the world, not in this column (client/js/sculptrail.js),
    // so the panel and the rail are asked together for whatever is wanted.
    const rail = toolRail((id) => pick(id));
    const q = (sel) => box.querySelector(sel) ?? rail.q(sel);
    const pick = (id) => pickBrush(rail, q, state, id, say);
    const state = { on: false, brush: 'raise', size: 12, strength: 0.5,
        shaping: null, areas: [], roads: [], painting: false,
        // Where the pointer last found ground, and whether that is this
        // land: what the brush is drawn at, and what colour.
        at: null, inside: null };
    // `say()` with nothing at all leaves what was said standing and only
    // counts the strokes again: letting go of a brush that refused must not
    // take the refusal off the screen.
    const say = (msg, bad = false) => {
        if (msg !== undefined) {
            q('.sc-status').textContent = msg;
            q('.sc-status').dataset.bad = bad ? '1' : '';
        }
        q('.sc-said').textContent = sentence(state);
        // What was already done to this land. `summary()` walks the whole
        // grid, so it is written when something happened and not on every
        // pointer move — `hover` is the one that runs sixty times a second.
        q('.sc-shaped').textContent = shapedLine(state.shaping);
        hover();
    };
    // What is under the brush, and how much of a line has been clicked out.
    const hover = () => {
        q('.sc-here').textContent = groundLine(state, ground);
        const n = (state.line ?? []).length;
        q('.sc-corners').textContent = n
            ? `${n} corner${n === 1 ? '' : 's'} clicked` : 'no corners yet';
    };

    const ground = (lon, lat) => ctx.groundAt?.(lon, lat) ?? 0;
    // The height Level aims at is the panel's own field. It was read off
    // `ctx.target`, which nothing ever passed: Number(undefined) is NaN, the
    // brush refused every cell, and Level silently did nothing at all.
    const paint = pointer(ctx, state, { say, hover: () => hover() }, ground,
        () => Number(q('.sc-target').value));

    const refresh = () => listLands(q, state, say, lands, choose);
    const choose = (id) => chooseLand(q, state, say, id);

    const toggle = (on) => shapeMode(ctx, state, rail, q, paint, say, on);

    const save = () => saveGround(state, say, ctx);
    const apply = () => layBed(q, state, say, ctx, ground);
    const clear = () => putBack(state, say, ctx);
    const take = () => levelHere(q, state, say, ground);

    wire(rail, q, state, { toggle, choose, refresh, save, apply, clear, take, say,
        ctx, pick });
    refresh();
    return { state, refresh, choose, toggle, save, apply, clear, take,
        shaping: () => state.shaping, say,
        // Drawn every frame by the page, the way the Place gizmo is.
        drawBrush: () => drawBrush({ ...ctx, shapedAt: (lon, lat) =>
            state.shaping?.at(lon, lat) ?? 0 }, state) };
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
    q('.sc-road').replaceChildren(new Option('pick a road…', ''),
        ...state.roads.map((r) => new Option(r.name, String(r.id))));
    say('');
    return state.shaping;
}

async function saveGround(state, say, ctx) {
    if (!state.shaping?.dirty) { say('nothing shaped yet'); return null; }
    try {
        const got = await state.shaping.save();
        say(`ground saved \u00b7 ${got.tiles} tile(s) changed`);
        ctx.onSaved?.();
        return got;
    } catch (err) {
        say(String(err.body?.message ?? err.message ?? err), true);
        return null;
    }
}

// The ground as the operator's elevation gave it: one stroke, undoable, and
// nothing anybody else sees until it is saved. There was no way back to it at
// all — a land somebody had flattened stayed flattened unless every cell was
// raised by hand.
function putBack(state, say, ctx) {
    const moved = state.shaping?.clear() ?? 0;
    ctx.onShaped?.();
    say(moved ? `${moved.toLocaleString()} cell(s) put back \u2014 Save to keep it`
        : 'this ground is already as the elevation gave it');
    return moved;
}

// What Level aims at, read off the ground rather than typed from nothing: it
// is a height above the sea, and the panel never said what one was.
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
    ctx.onShaped?.();
    say(`bed laid along ${got.metres.toFixed(0)} m \u00b7 steepest `
        + `${got.steepest.toFixed(1)} %`);
    return got;
}

// Which tool is in hand: lit on the rail, named over the box, and only the
// fields it reads on screen — "Level to" under Smooth is a control that does
// nothing, which is worse than no control at all. What it will do is said
// before the first drag rather than counted after it (client/js/sculptmode.js).
function pickBrush(rail, q, state, id, say) {
    state.brush = id;
    rail.pick(id);
    for (const label of rail.all('.sc-fields label')) {
        label.hidden = !brushUses(id, label.dataset.uses);
    }
    q('.sc-brush-says').textContent = brushLine(state);
    q('.sc-line-box').hidden = id !== 'line';
    say('');
}

// The rail, the fields, the keys, and the three that do something.
function wire(rail, q, state, acts) {
    const pick = acts.pick;
    q('.sc-toggle').addEventListener('change', (e) => acts.toggle(e.target.checked));
    q('.sc-land').addEventListener('change', (e) => acts.choose(e.target.value));
    const resize = (metres) => {
        state.size = Math.min(200, Math.max(1, Math.round(metres) || 12));
        q('.sc-size').value = String(state.size);
        q('.sc-brush-says').textContent = brushLine(state);
        acts.say('');
    };
    q('.sc-size').addEventListener('change', (e) => resize(Number(e.target.value)));
    q('.sc-strength').addEventListener('change', (e) => {
        state.strength = Number(e.target.value) || 0.5;
        q('.sc-brush-says').textContent = brushLine(state);
    });
    const undo = () => {
        acts.say(state.shaping?.undo() ? 'undone' : 'nothing to undo');
        acts.ctx.onShaped?.();
    };
    const redo = () => {
        acts.say(state.shaping?.redo() ? 'redone' : 'nothing to redo');
        acts.ctx.onShaped?.();
    };
    q('.sc-undo').onclick = undo;
    q('.sc-redo').onclick = redo;
    q('.sc-save').onclick = acts.save;
    q('.sc-apply').onclick = acts.apply;
    q('.sc-clear').onclick = acts.clear;
    q('.sc-take').onclick = acts.take;
    q('.sc-line-clear').onclick = () => {
        state.line = [];
        acts.ctx.onShaped?.();
        acts.say('the line is cleared \u2014 click its corners again');
    };
    // The keys the rail already prints on each glyph. Live only while shaping
    // is on: R is a letter somebody types into the name of a land.
    document.addEventListener('keydown',
        keyHandler(state, { brush: pick, size: resize, undo, redo }));
    pick(state.brush);
}

// Dragging on the 3D view: the ray lands on the heightfield, and the point it
// lands on is where the brush is. The same path the Place panel uses.
//
// The hand is the one tool that does not touch the ground: it moves the camera
// over it (client/js/sculptpan.js), so a drag with it in hand goes there and
// nowhere near the grid.
function pointer(ctx, state, { say, hover }, ground, levelTo) {
    const hand = panning(ctx);
    const where = (e) => {
        const rect = ctx.canvas.getBoundingClientRect();
        const r = rayThrough(ctx.camera, ctx.pc, e.clientX - rect.left, e.clientY - rect.top);
        const hit = raycastGround(ctx.terrain, r.from, r.dir);
        return hit ? ctx.origin.geodeticOf(hit) : null;
    };
    const one = (g) => dabAt(ctx, state, { say, hover }, ground, levelTo, g);
    return { on: [
        ['pointerdown', (e) => {
            if (state.brush === 'pan') {
                state.painting = hand.take(e);
                if (!state.painting) say('nothing under the pointer to take hold of', true);
                return;
            }
            const g = where(e);
            if (!g) { say('no ground under the pointer', true); return; }
            state.painting = true;
            state.shaping?.begin();
            if (state.brush === 'line') { state.line = [...(state.line ?? []), g]; return; }
            one(g);
        }],
        // Where the brush is, painting or not: the ring is drawn there every
        // frame, so the size of a twelve-metre brush is something you can see
        // rather than something you find out by moving the ground.
        ['pointermove', (e) => {
            if (state.brush === 'pan') { if (state.painting) hand.drag(e); return; }
            const g = where(e);
            state.at = g;
            state.inside = g ? Boolean(state.shaping?.inside(g.lon, g.lat)) : null;
            if (state.painting && g) one(g);
            else hover();
        }],
        ['pointerout', () => { state.at = null; hover(); }],
        // In and out over the land, with the hand in hand. The page's own
        // wheel would scroll the panel behind it.
        ['wheel', (e) => {
            if (state.brush !== 'pan') return;
            e.preventDefault();
            hand.zoom(e);
        }],
        // The stroke is only a stroke once it is let go of, and the line
        // under the panel counts strokes — so it is said again here.
        ['pointerup', () => { letGo(state, hand); say(); }],
        ['pointerleave', () => { letGo(state, hand); say(); }],
    ] };
}

function letGo(state, hand) {
    state.painting = false;
    hand.drop();
    state.shaping?.end();
}

// One dab of the brush in hand, where the pointer is.
function dabAt(ctx, state, { say, hover }, ground, levelTo, g) {
    if (!state.shaping) return;
    if (!state.shaping.inside(g.lon, g.lat)) {
        state.refused = true;
        say('You can only shape your own land', true);
        return;
    }
    dab(state.shaping, g.lon, g.lat, { brush: state.brush, size: state.size,
        strength: state.strength, ground,
        target: state.brush === 'level' ? levelTo() : undefined });
    ctx.onShaped?.();
    // The light line, not the whole panel: what has been shaped altogether
    // walks the grid, and this runs on every dab of a drag. The refusal is the
    // one thing that has to come off the screen the moment it stops being true.
    if (state.refused) { state.refused = false; say(''); } else hover();
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
