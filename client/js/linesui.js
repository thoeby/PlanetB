// linesui.js — Build → Lines: roads, streams, walls and hedges drawn on the
// Blueprint clay (PLAN-editors.md §2.3; EDT.13).
//
// Opening the surface opens the clay over the chosen land, as Shape does. A
// line never moves the ground by itself (D3): laying a bed is Shape's Along
// line, reached from a selected line. What is drawn is a `feature` row of a
// line kind the operator defined (client/lib/kinds.js), saved through the
// same row-level security everything else is (Invariant 6).

import * as api from './api.js';
import { entriesFor, entryOf } from '../lib/kinds.js';
import { Lines } from './lines.js';
import { aroundLand, onContour, snapNode } from './linesnap.js';
import { Shaping } from './sculpt.js';
import { drawTool, dropLast } from './linetool.js';
import { drawLines } from './linedraw.js';
import { deleteNode, handlesOf, hitAt, selectTool } from './lineedit.js';
import { mountNodeMenu } from './linesmenu.js';
import { mountSelected } from './linespanel.js';
import { drawMark } from './bpdraw.js';
import { LINE_TOOLS } from './linetools.js';
import { bindKeys, describeSelected, reselect, showProfile } from './linesdo.js';
import { mountKindPicker } from './kindpicker.js';
import { mountLeave } from './shapesave.js';
import { el, icon } from './tabbar.js';


const HTML = `
<div class="section">
  <label class="sh-land-row"><span class="label">Land</span>
    <select class="ln-land"></select></label>
</div>
<div class="ln-bar sc-bar"></div>
<p class="ln-status status"></p>
<div class="section"><div class="label">Kind</div><div class="ln-kinds"></div></div>
<div class="ln-selected-host"></div>
<div class="ln-list-host"></div>
<p class="note">A line never moves the ground. Select one and Lay bed to shape
  the ground under it in Shape. Nothing reaches the world until Save.</p>`;

function railOf(pick, acts) {
    const tools = el('div', { className: 'sc-rail ln-rail glass' }, ...LINE_TOOLS.map((t) => {
        const b = el('button', { type: 'button', className: `sc-brush ln-tool-${t.id}`,
            title: `${t.words} · ${t.key.toUpperCase()}` }, icon(t.icon),
        el('i', { className: 'sc-key', textContent: t.key.toUpperCase() }));
        b.dataset.tool = t.id;
        b.onclick = () => pick(t.id);
        return b;
    }));
    const deed = (cls, words, path, fn) => {
        const b = el('button', { type: 'button', className: `sc-deed ${cls}`, title: words },
            icon(path));
        b.onclick = fn;
        return b;
    };
    const deeds = el('div', { className: 'sc-deeds glass' },
        deed('ln-undo', 'Undo · Ctrl-Z', 'M3 10h11a5 5 0 0 1 0 10h-4|m3 10 5-5|m3 10 5 5',
            acts.undo),
        deed('ln-redo', 'Redo · Ctrl-Shift-Z',
            'M21 10H10a5 5 0 0 0 0 10h4|m21 10-5-5|m21 10-5 5', acts.redo),
        deed('ln-save', 'Save the lines', 'M5 4h11l3 3v13H5z|M8 4v6h7V4|M8 20v-6h8v6',
            acts.save));
    return { tools, deeds };
}

/**
 * ctx: {bpmode, bp, app, pc, reopen, onSaved}; `lands()` the player's areas.
 */
export function mountLines(host, ctx, { lands = () => [] } = {}) {
    const node = el('div');
    node.innerHTML = HTML;
    host.append(node);
    const q = (sel) => node.querySelector(sel);
    const state = { on: false, tool: 'draw', lines: null, drawing: null, at: null,
        selected: null, node: null, entries: [], areas: [] };
    const say = (msg, bad = false) => {
        q('.ln-status').textContent = msg;
        q('.ln-status').dataset.bad = bad ? '1' : '';
        selected?.draw();
        ctx.onChange?.(state);
    };
    let selected = null;
    const picker = mountKindPicker(q('.ln-kinds'), { store: 'splatworld.lines.recent' });
    const acts = actsOf(ctx, state, say, picker);
    const rail = railOf((id) => pickTool(q, state, id, say), acts);
    q('.ln-bar').append(rail.tools, rail.deeds);
    acts.pickTool = (id) => pickTool(q, state, id, say);
    const surface = linesSurface(ctx, state, acts, say);
    acts.deleteNode = surface.deleteNode;
    selected = mountSelected(q('.ln-selected-host'), ctx, state, say);
    q('.ln-land').addEventListener('change', (e) => chooseLand(ctx, state, e.target.value,
        surface, say));
    bindKeys(ctx, state, acts, picker, (id) => pickTool(q, state, id, say));
    pickTool(q, state, 'draw', say);
    const leave = mountLeave(document.getElementById('hud') ?? document.body);
    return { state, surface, picker, say, ...acts, q,
        lines: () => state.lines,
        async enter() {
            state.on = true;
            if (!state.entries.length) await loadKinds(state, picker);
            if (!state.lines) await listLands(q, state, lands);
            if (state.areas.length) {
                await chooseLand(ctx, state, q('.ln-land').value, surface, say);
            }
            else say('No land of yours to draw on — Land · 3.');
        },
        async leave() { await leaving(ctx, state, acts, leave, surface); },
    };
}

async function leaving(ctx, state, acts, leave, surface) {
    if (!state.on || state.asking) return;
    const n = state.lines?.items.filter((l) => l.state !== 'saved').length ?? 0;
    if (n) {
        state.asking = true;
        const answer = await leave.ask(`${n} line${n === 1 ? '' : 's'} on`
            + ` ${state.lines.area.rules?.name ?? 'this land'} not saved.`);
        state.asking = false;
        if (answer === 'stay') { ctx.reopen?.(); return; }
        if (answer === 'save') await acts.save();
        else state.lines = null;
    }
    state.on = false;
    state.drawing = null;
    if (ctx.bpmode.surface === surface) ctx.bpmode.close();
}

async function loadKinds(state, picker) {
    const [kinds, props] = await Promise.all([
        api.select('kind', { order: 'ordering' }).catch(() => []),
        api.select('property', { order: 'kind,ordering' }).catch(() => [])]);
    state.entries = entriesFor('line', kinds, props, state.defaults ?? {});
    picker.set(state.entries);
}

async function listLands(q, state, lands) {
    state.areas = (await lands()).filter((a) => a.may_write || a.may_propose);
    q('.ln-land').replaceChildren(...state.areas.map(
        (a) => new Option(a.rules?.name || 'unnamed land', a.id)));
}

async function chooseLand(ctx, state, id, surface, say) {
    const area = state.areas.find((a) => a.id === id) ?? state.areas[0];
    if (!area) return;
    if (state.lines?.area.id !== area.id) {
        state.lines = await Lines.load(area, state.entries);
        Object.assign(state, await aroundLand(area));
    }
    state.drawing = null;
    state.selected = null;
    if (!(ctx.bp.active && ctx.bpmode.surface === surface && ctx.bp.area?.id === area.id)) {
        // The clay is the land as it is shaped, so the grid comes too.
        await ctx.bpmode.open(area, await Shaping.load(area), surface);
    }
    say(`drawing on ${area.rules?.name ?? 'your land'} — click the ground`);
}

// How much ground a pixel of the screen is, at the camera's distance.
const metresPerPx = (ctx) => 2 * (ctx.bpmode.cam.state.distance ?? 400)
    * Math.tan(22.5 * Math.PI / 180) / (ctx.bpmode.cam.ctx.canvas.clientHeight || 800);

function actsOf(ctx, state, say, picker) {
    const heightAt = (lon, lat) => ctx.bp.heightAt(lon, lat);
    return {
        entry: () => picker.picked,
        snap: (g, e) => {
            // Alt held: the node goes to the first node's height along the
            // slope, and nothing else snaps (PLAN-editors idea 22).
            const first = state.drawing?.nodes[0];
            if (e?.altKey && first && g) {
                const on = onContour(g, ctx.bp.heightAt(first.lon, first.lat),
                    (lon, lat) => ctx.bp.heightAt(lon, lat));
                if (on) return { ...on, hit: null, follow: true };
            }
            return snapNode(state, g, e, { metresPerPx: metresPerPx(ctx),
                grid: ctx.bp.overlays.grid ? 1 : 0 });
        },
        finish() {
            const d = state.drawing;
            if (!d || d.nodes.length < 2) { say('a line needs two nodes', true); return null; }
            state.lines.add(d);
            state.drawing = null;
            say(`${d.kind} drawn — Save to keep it`);
            return d;
        },
        undo() {
            if (state.drawing && dropLast(state, say)) return;
            say(state.lines?.undo() ? 'undone' : 'nothing to undo');
            reselect(state);
        },
        redo() {
            say(state.lines?.redo() ? 'redone' : 'nothing to redo');
            reselect(state);
        },
        async save() {
            if (!state.lines?.dirty) { say('nothing drawn yet'); return null; }
            try {
                const got = await state.lines.save(heightAt);
                const n = got.saved + got.dropped;
                say(`${n} line${n === 1 ? '' : 's'} saved`);
                ctx.onSaved?.();
                return got;
            } catch (err) {
                say(String(err.body?.message ?? err.message ?? err), true);
                return null;
            }
        },
        say,
    };
}

function pickTool(q, state, id, say) {
    state.tool = id;
    for (const b of q('.ln-rail').children) {
        b.classList.toggle('picked', b.dataset.tool === id);
        b.setAttribute('aria-selected', String(b.dataset.tool === id));
    }
    say(LINE_TOOLS.find((t) => t.id === id)?.words ?? id);
}

function linesSurface(ctx, state, acts, say) {
    const draw = drawTool(state, { ...acts, say });
    const tol = () => 12 * metresPerPx(ctx);
    // What is said about the selection, and its profile along the bottom.
    const said = (words) => {
        say(words ?? describeSelected(state));
        showProfile(ctx, state);
    };
    const select = selectTool(state, { ...acts, tol, said });
    const menu = mountNodeMenu(document.getElementById('hud') ?? document.body, { state,
        done: (id, words) => {
            if (id === 'extend' && words) acts.pickTool('draw');
            say(words ?? 'that does not apply here', !words);
        } });
    const look = (line) => entryOf(state.entries, line.kind, line.props) ?? {};
    const tool = () => (state.tool === 'draw' ? draw : state.tool === 'select' ? select : null);
    return {
        tool: () => (state.tool === 'draw' || state.tool === 'select' ? 'tool' : state.tool),
        down: (g, e) => tool()?.down(g, e),
        move: (g, e) => { if (g) state.at = g; tool()?.move(g, e); },
        up: (g, e) => tool()?.up(g, e),
        // Where a node would land, said at the pointer before it is dropped.
        hover: (g, e) => {
            if (g) state.at = g;
            state.snap = g && state.tool === 'draw' ? acts.snap(g, e) : null;
        },
        describe: (g, base) => (state.snap ? { ...base, snapped: state.snap.hit,
            follow: state.snap.follow, inside: !state.snap.refused } : base),
        // A right click on a node of the selected line: its menu.
        context: (g, e) => {
            const hit = g && hitAt(state.lines?.live ?? [], state.selected, g, tol());
            if (hit?.kind === 'node') menu.open(hit.line, hit.i, e.clientX, e.clientY);
        },
        draw: () => {
            drawLines(ctx.bp, ctx.app, ctx.pc, { lines: state.lines?.live ?? [],
                drawing: state.drawing, look, selected: state.selected,
                at: state.tool === 'draw' ? state.at : null, ghosts: state.ghosts });
            if (state.selected) {
                for (const h of handlesOf(state.selected)) {
                    drawMark(ctx.bp, ctx.app, ctx.pc, h, new ctx.pc.Color(0.3, 0.85, 1), 0.8);
                }
            }
        },
        deleteNode: () => deleteNode(state, { said }),
    };
}

