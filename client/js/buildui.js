// buildui.js — build mode's panel, its input and its gizmo.
//
// Policy is in build.js and authority is in the database; this is the part that
// listens to a key and draws a line. While build mode is on the player is
// detached, so the camera stands still and the pointer is free: you are editing
// the world, not walking through it.
//
// The gizmo is keyboard-driven — an axis, a mode and a step — because a drag
// handle needs a picker this client does not have, and because a test can press
// a key. Snapping is on by default: a quarter metre, fifteen degrees, a tenth.

import { HTML } from './buildhtml.js';
import { placementDiff, propose } from './areas.js';
import { Edits, SNAP, areasAt, raycastGround, snapTo, tilesAt }
    from './build.js';
import { getAsset, searchAssets } from './catalog.js';
import { assetRow } from './buildrows.js';
import { describe, looker, saveAndSay, showChosen } from './buildsay.js';
import { mountHolding } from './holding.js';
import { mountUpdates } from './updatesui.js';
import { mountPorts } from './portsui.js';
import { mountObjectFlows } from './objectflows.js';
import { mountMovers } from './moversui.js';
import { frameFor } from './buildframe.js';

const AXES = ['x', 'y', 'z'];
const MODES = { move: 'move', turn: 'turn', size: 'size' };
const STEP = { move: SNAP.move, turn: SNAP.turn, size: SNAP.scale };
const TURN_KEY = { x: 'pitch', y: 'yaw', z: 'roll' };

// --------------------------------------------------------------------- maths

// A ray from the camera through a point on the canvas, in the anchor's frame.
export function rayThrough(camera, pc, x, y) {
    const near = camera.camera.screenToWorld(x, y, camera.camera.nearClip, new pc.Vec3());
    const far = camera.camera.screenToWorld(x, y, camera.camera.nearClip + 1, new pc.Vec3());
    const dir = far.clone().sub(near).normalize();
    return { from: { x: near.x, y: near.y, z: near.z }, dir: { x: dir.x, y: dir.y, z: dir.z } };
}

// Metres east/up/north become degrees, so a nudge is stored as a position and
// survives a rebase (origin.js).
function nudged(origin, row, axis, delta) {
    const local = origin.localOf({ lon: row.lon, lat: row.lat, h: row.h ?? 0 });
    local[axis] += delta;
    const g = origin.geodeticOf(local);
    return { lon: g.lon, lat: g.lat, h: g.h };
}

export function patchFor(origin, row, mode, axis, delta) {
    if (mode === MODES.move) return nudged(origin, row, axis, delta);
    if (mode === MODES.turn) {
        const key = TURN_KEY[axis];
        return { [key]: snapTo((row[key] ?? 0) + delta, SNAP.turn) };
    }
    return { scale: Math.max(0.05, snapTo((row.scale ?? 1) + delta, SNAP.scale)) };
}

// ------------------------------------------------------------------ session

// Everything build mode does to the world, with no DOM in it beyond the one
// callback the panel installs.
class Session {
    constructor(ctx, onChange) {
        this.ctx = ctx;
        this.onChange = onChange;
        this.state = { on: false, brush: null, selected: null, mode: MODES.move,
            axis: 'x', snap: true, area: null, proposal: null };
        this.edits = new Edits({ onChange: () => this.onChange() });
    }

    here() { return this.ctx.origin.geodeticOf(this.ctx.camera.getPosition()); }

    // Which area the camera is standing over, and what its tiles owe. A writer
    // gets the area they may write; a proposer gets the one they may propose in
    // (WP4.3), and place() then makes a proposal instead of a row.
    async look() {
        const g = this.here();
        const areas = await areasAt(g.lon, g.lat).catch(() => []);
        this.state.area = areas.find((a) => a.may_write)
            ?? areas.find((a) => a.may_propose) ?? null;
        // Whose land this is, for somebody who may do nothing on it (FL.6).
        this.state.landHere = areas[0] ?? null;
        const tiles = await tilesAt(g.lon, g.lat, this.state.area?.detail ?? 14).catch(() => []);
        return { areas, tiles };
    }

    ray(screen) {
        const r = rayThrough(this.ctx.camera, this.ctx.pc, screen.x, screen.y);
        return raycastGround(this.ctx.terrain, r.from, r.dir);
    }

    // The ray lands on the heightfield; the area under it decides whether the
    // insert is worth attempting, and RLS decides whether it succeeds. Where
    // the caller may only propose, the same placement becomes a proposal —
    // which is what an `edit` grant means (WP4.3).
    async place(screen) {
        if (!this.state.brush || !this.state.area) return null;
        const hit = this.ray(screen);
        if (!hit) return null;
        const g = this.ctx.origin.geodeticOf(hit);
        const at = { lon: g.lon, lat: g.lat, h: g.h };
        const pose = { yaw: 0, scale: 1 };
        if (!this.state.area.may_write) {
            this.state.proposal = await propose(this.state.area.id,
                placementDiff(this.state.brush.san, at, pose));
            this.onChange();
            return this.state.proposal;
        }
        const row = this.edits.place(this.state.area.id, this.state.brush.san, at,
            { ...pose, sha256: this.state.brush.sha256 });
        this.state.selected = row;
        return this.sync();
    }

    // FND.16: where on the ground the pointer is, for a route being drawn.
    at(screen) {
        const hit = this.ray(screen);
        return hit ? this.ctx.origin.geodeticOf(hit) : null;
    }

    async pick(screen) {
        const hit = this.ray(screen);
        if (!hit) return null;
        this.state.selected = this.ctx.preview.nearest(hit) ?? null;
        this.onChange();
        return this.state.selected;
    }

    async step(sign) {
        const { selected, mode, axis, snap } = this.state;
        if (!selected) return null;
        const size = (snap ? STEP[mode] : STEP[mode] / 5) * sign;
        const patch = patchFor(this.ctx.origin, selected, mode, axis, size);
        this.state.selected = await this.edits.transform(selected, patch);
        return this.sync();
    }

    async remove() {
        if (!this.state.selected) return null;
        await this.edits.remove(this.state.selected);
        this.state.selected = null;
        await this.sync();
        return null;
    }

    async undo() {
        const row = await this.edits.undo();
        this.state.selected = row ?? null;
        await this.sync();
        return this.state.selected;
    }

    // Everything within sight of the camera, so a placement shows up at once
    // and a delete disappears. What is still being placed is drawn from this
    // tab's own list: nobody else has it yet (SPEC §0.3).
    async sync() {
        const g = this.here();
        const rows = await this.ctx.nearby(g.lon, g.lat);
        await this.ctx.preview.sync([...rows, ...this.edits.pending]);
        const id = this.state.selected?.id;
        if (id) this.state.selected = rows.find((r) => r.id === id) ?? this.state.selected;
        this.onChange();
        return this.state.selected;
    }

    // SPEC §3.4 step 4: Save, and the panel says what was saved and what it
    // changed. Until this, nothing has left the tab.
    async save() {
        const done = await this.edits.save();
        await this.sync();
        return done;
    }
}

// ------------------------------------------------------------------- mount

// A three-line axis cross on the selection: no picking, just somewhere to look
// while the keys do the moving.
function drawGizmo(ctx, state) {
    if (!state.on || !state.selected) return;
    const { pc, app, origin } = ctx;
    const s = state.selected;
    const p = origin.localOf({ lon: s.lon, lat: s.lat, h: s.h ?? 0 });
    const at = new pc.Vec3(p.x, p.y, p.z);
    const colours = { x: pc.Color.RED, y: pc.Color.GREEN, z: pc.Color.BLUE };
    for (const axis of AXES) {
        const end = at.clone();
        end[axis] += 2 * (s.scale ?? 1) * (axis === state.axis ? 1.6 : 1);
        app.drawLine(at, end, colours[axis]);
    }
}

// Every one of these is a button on the panel as well (T5: no key you have to
// know). G/R/T pick what a step does, X/Y/Z pick the axis, the brackets and the
// arrows take a step, Delete removes and Ctrl-Z undoes — for the hands that
// already know them. A key typed into the search box is a search, not a
// command.
function keyHandler(state, acts, say) {
    return (e) => {
        if (!state.on || e.target.tagName === 'INPUT') return;
        const mode = { KeyG: MODES.move, KeyR: MODES.turn, KeyT: MODES.size }[e.code];
        if (mode) { state.mode = mode; say(); return; }
        if (e.code === 'KeyZ' && e.ctrlKey) { acts.undo(); return; }
        const axis = ['KeyX', 'KeyY', 'KeyZ'].indexOf(e.code);
        if (axis >= 0) { state.axis = AXES[axis]; say(); return; }
        if (e.code === 'BracketRight' || e.code === 'ArrowUp') acts.step(1);
        else if (e.code === 'BracketLeft' || e.code === 'ArrowDown') acts.step(-1);
        else if (e.code === 'Delete' || e.code === 'Backspace') acts.remove();
    };
}

function toggler(host, ctx, state, { acts, onKey, onClick, say }) {
    return (on) => {
        state.on = on ?? !state.on;
        host.querySelector('.build-toggle').checked = state.on;
        host.dataset.on = state.on ? '1' : '';
        if (state.on) {
            ctx.player.detach();
            document.exitPointerLock?.();
            window.addEventListener('keydown', onKey);
            ctx.canvas.addEventListener('click', onClick);
            acts.sync();
        } else {
            window.removeEventListener('keydown', onKey);
            ctx.canvas.removeEventListener('click', onClick);
            ctx.player.attach(ctx.canvas);
        }
        say();
        return state.on;
    };
}

// UI.3: the panel says how to put a picked product down; picked from the
// Inventory (`frame`), the camera also steps back and up to fit its size. A
// pick from the list here leaves the view where the player put it.
function choose(host, ctx, state, say) {
    return (asset, { frame = false } = {}) => {
        state.brush = asset;
        state.selected = null;
        if (frame && state.on && asset) frameFor(ctx, asset);
        const hint = host.querySelector('.build-hint');
        if (hint) {
            const name = asset?.name ?? asset?.san;
            hint.textContent = asset
                ? `Click the ground to put ${name} down \u00b7 Esc leaves build mode` : '';
        }
        say();
    };
}

async function fillCatalog(host, state, pick, search) {
    // Models only (FND.5): the other four types are used by symbols — a
    // repeating piece runs along a wall, a cross-section is a road's profile, a
    // collection is what a forest is scattered from, a material covers ground.
    // None of them is a thing anybody puts down one of.
    const rows = await searchAssets({ search, type: 'model', limit: 12 }).catch(() => []);
    host.querySelector('.build-assets').replaceChildren(...rows.map((a) => assetRow(a, pick)));
    return rows;
}

function wire(host, state, { toggle, catalog, acts, say }) {
    const q = (sel) => host.querySelector(sel);
    q('.build-toggle').onchange = (e) => toggle(e.target.checked);
    q('.build-search').onchange = (e) => catalog(e.target.value);
    q('.build-snap-on').onchange = (e) => { state.snap = e.target.checked; };
    q('.build-del').onclick = () => acts.remove();
    q('.build-undo').onclick = () => acts.undo();
    q('.build-save').onclick = () => acts.save();
    for (const b of host.querySelectorAll('[data-mode]')) {
        b.onclick = () => { state.mode = b.dataset.mode; say(); };
    }
    for (const b of host.querySelectorAll('[data-axis]')) {
        b.onclick = () => { state.axis = b.dataset.axis; say(); };
    }
    q('.build-less').onclick = () => acts.step(-1);
    q('.build-more').onclick = () => acts.step(1);
}

// The buttons say what is chosen, so nothing on this panel is only in
// somebody's head (T5).
function followSelection(state, ports, flowsOf, holding, updates) {
    let showing = null;
    return async () => {
        const row = Edits.isPlacing(state.selected) ? null : state.selected;
        if ((row?.id ?? null) === showing) return;
        showing = row?.id ?? null;
        const asset = row ? await getAsset(row.san).catch(() => null) : null;
        // LV.4: a thing that may be carried may be picked up by anybody.
        holding.show(row, asset);
        // LV.9: the version it runs, and an update waiting on its owner.
        await updates.show(row, Boolean(state.area?.may_write));
        await ports.show(row && { id: row.id, san: row.san,
            mine: Boolean(state.area?.may_write) }, asset);
        // FL.6: the flows that belong to it.
        await flowsOf.show(row && { id: row.id, area_id: row.area_id ?? state.area?.id,
            name: asset?.name ?? row.san,
            land: state.area?.name ?? state.landHere?.name ?? 'this land',
            mine: Boolean(state.area?.may_write) });
    };
}

export function mountBuild(host, ctx) {
    host.innerHTML = HTML;
    const q = (sel) => host.querySelector(sel);
    const session = new Session(ctx, () => say());
    const { state } = session;

    const ports = mountPorts(host, { wrote: ctx.live?.wrote });
    const objectFlows = mountObjectFlows(host, ctx.automate ?? {});
    const holding = mountHolding(host, { camera: ctx.camera, origin: ctx.origin,
        terrain: ctx.terrain,
        changed: async () => { state.selected = null; await acts.sync(); } });
    const updates = mountUpdates(host);
    const showPorts = followSelection(state, ports, objectFlows, holding, updates);
    // FND.16: the buses on this land, and the route being drawn for a new one.
    const movers = mountMovers(host, { clock: () => ctx.movers?.clock() ?? Date.now() / 1000 });

    const say = () => {
        q('.build-sel').textContent = describe(state, session.edits.depth);
        showChosen(host, state);
        showPorts();
    };

    const refresh = looker(host, ctx, session, say, movers);
    const after = (fn) => async (...args) => {
        const r = await fn(...args);
        await refresh();
        return r;
    };
    const acts = {
        sync: after(() => session.sync()),
        place: after((screen) => session.place(screen)),
        step: after((sign) => session.step(sign)),
        remove: after(() => session.remove()),
        undo: after(() => session.undo()),
        save: () => saveAndSay(session, refresh, q('.build-saved')),
    };

    const onKey = keyHandler(state, acts, say);
    const onClick = async (e) => {
        const rect = ctx.canvas.getBoundingClientRect();
        const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        // A click while a route is being drawn is a corner of it, and neither
        // a thing being picked up nor a thing being put down.
        if (movers.drawing()) { movers.corner(session.at(screen)); return; }
        if (!(await session.pick(screen))) await acts.place(screen);
    };

    const toggle = toggler(host, ctx, state, { acts, onKey, onClick, say });
    const pick = choose(host, ctx, state, say);
    const catalog = (search = '') => fillCatalog(host, state, pick, search);
    wire(host, state, { toggle, catalog, acts, say });
    say();

    holding.refresh();
    return { state, toggle, refresh, catalog, ports, movers, holding, ...acts,
        pick: (s) => session.pick(s),
        drawGizmo: () => drawGizmo(ctx, state), edits: session.edits,
        setBrush: pick };
}
