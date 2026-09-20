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
import { BRUSHES, Shaping, brushWords } from './sculpt.js';
import { alongLine, dab } from './sculptbrush.js';
import { el } from './poolui.js';
import { rayThrough } from './buildui.js';
import { raycastGround } from './build.js';
import { BRUSH_SAYS, brushLine, brushUses, drawBrush, keyHandler } from './sculptmode.js';

const HTML = `
<div class="section">
  <div class="row">
    <label class="sc-on-box"><input type="checkbox" class="sc-toggle"> Shape this land</label>
    <select class="sc-land"></select>
  </div>
  <div class="note">Drag on the ground to shape it. What you shape is metres
    off the ground the operator's elevation says is there, so a better
    elevation later keeps your shaping. While shaping is on you stand still —
    turn it off to walk away.</div>
</div>
<div class="section">
  <div class="spread">
    <span class="label">Brush</span>
    <span class="muted sc-keys">R F S G L B · [ ] resize · Ctrl-Z undo</span>
  </div>
  <div class="row sc-brushes"></div>
  <p class="note sc-brush-says"></p>
  <div class="row sc-fields">
    <label data-uses="size">Size (m)<input class="sc-size" type="number" min="1"
      max="200" value="12"></label>
    <label data-uses="strength">Strength (m)<input class="sc-strength" type="number"
      min="0.05" step="0.05" value="0.5"></label>
    <label data-uses="target">Level to (m)<input class="sc-target" type="number"
      step="0.5"></label>
  </div>
</div>
<div class="section sc-line-box" hidden>
  <span class="label">Along a line</span>
  <div class="note">Click points along the path, or take one of this land's
    roads, and the bed is written once.</div>
  <div class="row">
    <select class="sc-road"></select>
    <label>Width (m)<input class="sc-width" type="number" min="1" value="7"></label>
    <label>Shoulder (m)<input class="sc-shoulder" type="number" min="0" value="1"></label>
    <label>Gradient (%)<input class="sc-gradient" type="number" min="1" value="8"></label>
  </div>
  <button type="button" class="sc-apply primary">Apply</button>
</div>
<div class="section">
  <div class="row">
    <button type="button" class="sc-undo">Undo</button>
    <button type="button" class="sc-redo">Redo</button>
    <button type="button" class="sc-save primary">Save</button>
  </div>
  <p class="sc-status status"></p>
  <p class="muted sc-said"></p>
</div>`;

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
    const q = (sel) => box.querySelector(sel);
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
    };

    const ground = (lon, lat) => ctx.groundAt?.(lon, lat) ?? 0;
    // The height Level aims at is the panel's own field. It was read off
    // `ctx.target`, which nothing ever passed: Number(undefined) is NaN, the
    // brush refused every cell, and Level silently did nothing at all.
    const paint = pointer(ctx, state, say, ground,
        () => Number(q('.sc-target').value));

    const refresh = () => listLands(q, state, say, lands, choose);
    const choose = (id) => chooseLand(q, state, say, id);

    const toggle = (on) => {
        state.on = on ?? !state.on;
        q('.sc-toggle').checked = state.on;
        if (state.on) {
            ctx.player.detach();
            document.exitPointerLock?.();
            for (const [name, fn] of paint.on) ctx.canvas.addEventListener(name, fn);
        } else {
            for (const [name, fn] of paint.on) ctx.canvas.removeEventListener(name, fn);
            ctx.player.attach(ctx.canvas);
        }
        say(state.on ? 'shaping — drag on the ground' : '');
        return state.on;
    };

    const save = () => saveGround(state, say, ctx);
    const apply = () => layBed(q, state, say, ctx, ground);

    wire(box, q, state, { toggle, choose, refresh, save, apply, say, ctx });
    refresh();
    return { state, refresh, choose, toggle, save, apply,
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

// Which brush is in hand: the button picked out, only the fields it reads on
// screen, and what it will do said before the first drag rather than counted
// after it (client/js/sculptmode.js).
function pickBrush(box, q, state, id, say) {
    state.brush = id;
    for (const b of box.querySelectorAll('.sc-brush')) {
        b.classList.toggle('picked', b.dataset.brush === id);
    }
    for (const label of box.querySelectorAll('.sc-fields label')) {
        label.hidden = !brushUses(id, label.dataset.uses);
    }
    q('.sc-brush-says').textContent = brushLine(state);
    q('.sc-line-box').hidden = id !== 'line';
    say('');
}

// The brush buttons, the fields, the keys, and the three that do something.
function wire(box, q, state, acts) {
    const pick = (id) => pickBrush(box, q, state, id, acts.say);
    q('.sc-brushes').replaceChildren(...BRUSHES.map((b) => {
        const button = el('button', { type: 'button', className: `sc-brush sc-brush-${b.id}`,
            textContent: `${b.words} (${b.key.toUpperCase()})`,
            title: BRUSH_SAYS[b.id]?.does ?? '' });
        button.dataset.brush = b.id;
        button.onclick = () => pick(b.id);
        return button;
    }));
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
    // The keys the buttons already print. Live only while shaping is on: R is
    // a letter somebody types into the name of a land.
    document.addEventListener('keydown',
        keyHandler(state, { brush: pick, size: resize, undo, redo }));
    pick(state.brush);
}

// Dragging on the 3D view: the ray lands on the heightfield, and the point it
// lands on is where the brush is. The same path the Place panel uses.
function pointer(ctx, state, say, ground, levelTo) {
    const where = (e) => {
        const rect = ctx.canvas.getBoundingClientRect();
        const r = rayThrough(ctx.camera, ctx.pc, e.clientX - rect.left, e.clientY - rect.top);
        const hit = raycastGround(ctx.terrain, r.from, r.dir);
        return hit ? ctx.origin.geodeticOf(hit) : null;
    };
    const one = (g) => {
        if (!state.shaping) return;
        if (!state.shaping.inside(g.lon, g.lat)) {
            say('You can only shape your own land', true);
            return;
        }
        dab(state.shaping, g.lon, g.lat, { brush: state.brush, size: state.size,
            strength: state.strength, ground,
            target: state.brush === 'level' ? levelTo() : undefined });
        ctx.onShaped?.();
        say('');
    };
    return { on: [
        ['pointerdown', (e) => {
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
            const g = where(e);
            state.at = g;
            state.inside = g ? Boolean(state.shaping?.inside(g.lon, g.lat)) : null;
            if (state.painting && g) one(g);
        }],
        ['pointerout', () => { state.at = null; }],
        // The stroke is only a stroke once it is let go of, and the line
        // under the panel counts strokes — so it is said again here.
        ['pointerup', () => { state.painting = false; state.shaping?.end(); say(); }],
        ['pointerleave', () => { state.painting = false; state.shaping?.end(); say(); }],
    ] };
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
