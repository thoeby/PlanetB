// linesui.js — Build → Lines: roads, streams, walls and hedges drawn on the
// Blueprint clay (PLAN-editors.md §2.3; EDT.13).
//
// Opening the surface opens the clay over the chosen land, as Shape does. A
// line never moves the ground by itself (D3): laying a bed is Shape's Along
// line, reached from a selected line. What is drawn is a `feature` row of a
// line kind the operator defined (client/lib/kinds.js), saved through the
// same row-level security everything else is (Invariant 6).

import * as api from './api.js';
import { defaultsFrom, entriesFor, entryOf } from '../lib/kinds.js';
import { Lines } from './lines.js';
import { aroundLand, onContour, snapNode } from './linesnap.js';
import { Shaping } from './sculpt.js';
import { drawTool, dropLast } from './linetool.js';
import { drawLines } from './linedraw.js';
import { deleteNode, handlesOf, hitAt, selectTool } from './lineedit.js';
import { mountNodeMenu } from './linesmenu.js';
import { mountFields, mountList, mountSelected } from './linespanel.js';
import { drawMark } from './bpdraw.js';
import { LINE_TOOLS } from './linetools.js';
import { bindKeys, describeSelected, reselect, showProfile } from './linesdo.js';
import { mountKindPicker } from './kindpicker.js';
import { mountLeave } from './shapesave.js';
import { linesBar } from './linesbar.js';
import { whileLoading } from './bploading.js';
import { el } from './tabbar.js';


// The panel itself is not on screen while Lines is (client/lines.css): the
// toolbar and its cards are over the land (client/js/linesbar.js).
const HTML = `
<p class="note">Lines is the toolbar over the land, top left. A line never moves
  the ground: select one and Lay bed to shape the ground under it in Shape.
  Nothing reaches the world until Save.</p>`;

/**
 * ctx: {bpmode, bp, app, pc, reopen, onSaved}; `lands()` the player's areas.
 */
export function mountLines(host, ctx, { lands = () => [] } = {}) {
    const node = el('div');
    node.innerHTML = HTML;
    host.append(node);
    const state = { on: false, tool: 'draw', lines: null, drawing: null, at: null,
        selected: null, node: null, entries: [], areas: [] };
    let acts = null;
    const bar = linesBar(document.getElementById('hud') ?? document.body,
        (id) => pickTool(bar, state, id, say, { toggle: true }),
        { save: () => acts.save(), undo: () => acts.undo(), redo: () => acts.redo() });
    const q = (sel) => bar.q(sel) ?? node.querySelector(sel);
    const say = (msg, bad = false) => {
        q('.ln-status').textContent = msg;
        q('.ln-status').dataset.bad = bad ? '1' : '';
        q('.ln-said').textContent = unsaved(state);
        bar.selected.hidden = !state.selected;
        for (const part of parts) part.draw();
        ctx.onChange?.(state);
    };
    const parts = [];
    const picker = mountKindPicker(q('.ln-kinds'), { store: 'splatworld.lines.recent' });
    acts = actsOf(ctx, state, say, picker);
    acts.pickTool = (id) => pickTool(bar, state, id, say);
    const surface = linesSurface(ctx, state, acts, say);
    acts.deleteNode = surface.deleteNode;
    parts.push(mountSelected(q('.ln-selected-host'), ctx, state, say),
        mountFields(q('.ln-selected-host'), state, say),
        mountList(q('.ln-list-host'), ctx, state, (line) => {
            state.selected = line;
            state.node = null;
            pickTool(bar, state, 'select', say);
            say(describeSelected(state));
            showProfile(ctx, state);
        }));
    q('.ln-land').addEventListener('change', (e) => whileLoading(ctx.bpmode.loading,
        'Opening the land as clay…', () => chooseLand(ctx, state, e.target.value, surface, say)));
    bindKeys(ctx, state, acts, picker, (id) => pickTool(bar, state, id, say));
    pickTool(bar, state, 'draw', say);
    const leave = mountLeave(document.getElementById('hud') ?? document.body);
    return { state, surface, picker, say, ...acts, q,
        lines: () => state.lines,
        async enter() {
            state.on = true;
            bar.node.hidden = false;
            ctx.bpmode.hold(surface);
            await whileLoading(ctx.bpmode.loading, 'Opening your land as clay…', async () => {
                if (!state.entries.length) await loadKinds(state, picker);
                if (!state.lines) await listLands(q, state, lands);
                if (state.areas.length) {
                    await chooseLand(ctx, state, q('.ln-land').value, surface, say);
                }
                else say('No land of yours to draw on — Land · 3.');
            });
        },
        async leave() { await leaving(ctx, state, acts, leave, { surface, bar }); },
    };
}

async function leaving(ctx, state, acts, leave, { surface, bar }) {
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
    bar.node.hidden = true;
    if (ctx.bpmode.surface === surface) ctx.bpmode.close();
    else ctx.bpmode.release(surface);
}

// How much is not saved yet, in the bar.
function unsaved(state) {
    const n = state.lines?.items.filter((l) => l.state !== 'saved').length ?? 0;
    return n ? `${n} line${n === 1 ? '' : 's'} unsaved` : '';
}

async function loadKinds(state, picker) {
    const [kinds, props, own] = await Promise.all([
        api.select('kind', { order: 'ordering' }).catch(() => []),
        api.select('property', { order: 'kind,ordering' }).catch(() => []),
        api.select('kind_default').catch(() => [])]);
    state.properties = props;
    // What the operator says a kind is (db/0199, EDT.23), over the guesses.
    state.entries = entriesFor('line', kinds, props, defaultsFrom(own));
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

function pickTool(bar, state, id, say, how) {
    state.tool = id;
    bar.pick(id, how);
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
                at: state.tool === 'draw' ? state.at : null,
                // Neighbours' lines and every area's edge, faint and not
                // selectable, while the switch says so (PLAN-editors idea 27).
                ghosts: ctx.bp.overlays.neighbours ? state.ghosts : [],
                edges: ctx.bp.overlays.neighbours ? state.edges : [] });
            if (state.selected) {
                for (const h of handlesOf(state.selected)) {
                    drawMark(ctx.bp, ctx.app, ctx.pc, h, new ctx.pc.Color(0.3, 0.85, 1), 0.8);
                }
            }
        },
        deleteNode: () => deleteNode(state, { said }),
    };
}

