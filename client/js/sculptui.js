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

const HTML = `
<div class="section">
  <div class="row">
    <label class="sc-on-box"><input type="checkbox" class="sc-toggle"> Shape this land</label>
    <select class="sc-land"></select>
  </div>
  <div class="note">Drag on the ground to shape it. What you shape is metres
    off the ground the operator's elevation says is there, so a better
    elevation later keeps your shaping.</div>
</div>
<div class="section">
  <span class="label">Brush</span>
  <div class="row sc-brushes"></div>
  <div class="row">
    <label>Size (m)<input class="sc-size" type="number" min="1" max="200" value="12"></label>
    <label>Strength (m)<input class="sc-strength" type="number" min="0.05"
      step="0.05" value="0.5"></label>
    <label>Level to (m)<input class="sc-target" type="number" step="0.5"></label>
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
        shaping: null, areas: [], roads: [], painting: false };
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
    const paint = pointer(ctx, state, say, ground);

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
        shaping: () => state.shaping, say };
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

// The brush buttons, the fields, and the three that do something.
function wire(box, q, state, acts) {
    q('.sc-brushes').replaceChildren(...BRUSHES.map((b) => {
        const button = el('button', { type: 'button', className: `sc-brush sc-brush-${b.id}`,
            textContent: `${b.words} (${b.key.toUpperCase()})` });
        button.onclick = () => {
            state.brush = b.id;
            for (const other of box.querySelectorAll('.sc-brush')) {
                other.classList.toggle('picked', other === button);
            }
            q('.sc-line-box').hidden = b.id !== 'line';
            acts.say('');
        };
        return button;
    }));
    box.querySelector('.sc-brush-raise').classList.add('picked');
    q('.sc-toggle').addEventListener('change', (e) => acts.toggle(e.target.checked));
    q('.sc-land').addEventListener('change', (e) => acts.choose(e.target.value));
    q('.sc-size').addEventListener('change', (e) => {
        state.size = Number(e.target.value) || 12;
        acts.say('');
    });
    q('.sc-strength').addEventListener('change', (e) => {
        state.strength = Number(e.target.value) || 0.5;
    });
    q('.sc-undo').onclick = () => {
        acts.say(state.shaping?.undo() ? 'undone' : 'nothing to undo');
        acts.ctx.onShaped?.();
    };
    q('.sc-redo').onclick = () => {
        acts.say(state.shaping?.redo() ? 'redone' : 'nothing to redo');
        acts.ctx.onShaped?.();
    };
    q('.sc-save').onclick = acts.save;
    q('.sc-apply').onclick = acts.apply;
}

// Dragging on the 3D view: the ray lands on the heightfield, and the point it
// lands on is where the brush is. The same path the Place panel uses.
function pointer(ctx, state, say, ground) {
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
            target: state.brush === 'level' ? Number(ctx.target?.()) : undefined });
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
        ['pointermove', (e) => { if (state.painting) { const g = where(e); if (g) one(g); } }],
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
