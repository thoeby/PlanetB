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

import * as api from './api.js';
import { placementDiff, propose } from './areas.js';
import { Edits, SNAP, areasAt, raycastGround, snapTo, tilesAt } from './build.js';
import { searchAssets } from './catalog.js';

const HTML = `
<label class="build-on"><input type="checkbox" class="build-toggle"> build mode</label>
<div class="build-where muted">—</div>
<input class="build-search" type="search" placeholder="catalog: search assets">
<ul class="build-assets"></ul>
<div class="build-sel muted">nothing selected</div>
<div class="build-gizmo">
  <button type="button" data-mode="move">move</button>
  <button type="button" data-mode="turn">turn</button>
  <button type="button" data-mode="size">size</button>
  <span class="build-axis">x</span>
  <label class="build-snap"><input type="checkbox" class="build-snap-on" checked> snap</label>
</div>
<div class="build-acts">
  <button type="button" class="build-del">delete</button>
  <button type="button" class="build-undo">undo</button>
</div>
<ul class="build-tiles"></ul>`;

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
        const row = await this.edits.place(this.state.area.id, this.state.brush.san, at, pose);
        this.state.selected = { ...row, sha256: this.state.brush.sha256 };
        return this.sync();
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
    // and a delete disappears.
    async sync() {
        const g = this.here();
        const rows = await this.ctx.nearby(g.lon, g.lat);
        await this.ctx.preview.sync(rows);
        const id = this.state.selected?.id;
        if (id) this.state.selected = rows.find((r) => r.id === id) ?? this.state.selected;
        this.onChange();
        return this.state.selected;
    }
}

// --------------------------------------------------------------------- rows

function assetRow(asset, onPick) {
    const li = document.createElement('li');
    li.className = 'build-asset';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${asset.name} · ${asset.san}`;
    b.onclick = () => onPick(asset);
    li.append(b);
    return li;
}

function tileRow(t, onRender) {
    const li = document.createElement('li');
    li.className = 'build-tile';
    li.textContent = `${t.z}/${t.x}/${t.y} v${t.expected_version}${t.dirty ? ' dirty' : ''} `;
    if (t.dirty) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = t.job_id ? `job ${t.job_id}` : 'render now';
        b.onclick = () => onRender(t, b);
        li.append(b);
    }
    return li;
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

// G/R/T pick what a step does, X/Y/Z pick the axis, the brackets and the arrows
// take a step, Delete removes and Ctrl-Z undoes. A key typed into the search
// box is a search, not a command.
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

function describe(state, depth) {
    if (state.proposal && !state.selected) {
        return `proposed ${String(state.proposal).slice(0, 8)} — an approver has to merge it`;
    }
    if (!state.selected) {
        return `${state.brush ? `brush ${state.brush.san}` : 'nothing selected'}`
            + ` · ${depth} undoable`;
    }
    return `${state.selected.san} · ${state.mode} ${state.axis}`
        + ` · scale ${Number(state.selected.scale ?? 1).toFixed(2)} · ${depth} undoable`;
}

const whereText = (state, areas) => {
    if (!state.area) {
        return areas.length ? 'this land is not yours to build on' : 'no area here';
    }
    const how = state.area.may_write ? 'building in' : 'proposing to';
    return `${how} ${state.area.id.slice(0, 8)} · detail ${state.area.detail}`;
};

// Build mode takes the keyboard and the pointer off the player: the camera
// stands still and the cursor is free, which is what makes a click a placement
// rather than a request for pointer lock.
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

async function fillCatalog(host, state, say, search) {
    const rows = await searchAssets({ search, limit: 12 }).catch(() => []);
    host.querySelector('.build-assets').replaceChildren(...rows.map((a) => assetRow(a, (asset) => {
        state.brush = asset;
        state.selected = null;
        say();
    })));
    return rows;
}

function wire(host, state, { toggle, catalog, acts, say }) {
    const q = (sel) => host.querySelector(sel);
    q('.build-toggle').onchange = (e) => toggle(e.target.checked);
    q('.build-search').onchange = (e) => catalog(e.target.value);
    q('.build-snap-on').onchange = (e) => { state.snap = e.target.checked; };
    q('.build-del').onclick = () => acts.remove();
    q('.build-undo').onclick = () => acts.undo();
    for (const b of host.querySelectorAll('[data-mode]')) {
        b.onclick = () => { state.mode = b.dataset.mode; say(); };
    }
}

export function mountBuild(host, ctx) {
    host.innerHTML = HTML;
    const q = (sel) => host.querySelector(sel);
    const session = new Session(ctx, () => say());
    const { state } = session;

    const say = () => {
        q('.build-sel').textContent = describe(state, session.edits.depth);
        q('.build-axis').textContent = state.axis;
    };

    async function render(tile, btn) {
        btn.disabled = true;
        const job = await api.rpc('ensure_job', { z: tile.z, x: tile.x, y: tile.y });
        btn.textContent = `job ${job}`;
        ctx.work?.refresh?.();
        // WP4.4: a job is what a bounty attaches to, so the wallet is told
        // which one the player just opened.
        ctx.wallet?.target?.(tile, job);
    }

    async function refresh() {
        say();
        if (!state.on) return null;
        const { areas, tiles } = await session.look();
        q('.build-where').textContent = whereText(state, areas);
        q('.build-tiles').replaceChildren(...tiles.map((t) => tileRow(t, render)));
        const open = tiles.find((t) => t.job_id) ?? tiles.find((t) => t.dirty);
        if (open) ctx.wallet?.target?.(open, open.job_id ?? null);
        return tiles;
    }

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
    };

    const onKey = keyHandler(state, acts, say);
    const onClick = async (e) => {
        const rect = ctx.canvas.getBoundingClientRect();
        const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        if (!(await session.pick(screen))) await acts.place(screen);
    };

    const toggle = toggler(host, ctx, state, { acts, onKey, onClick, say });
    const catalog = (search = '') => fillCatalog(host, state, say, search);
    wire(host, state, { toggle, catalog, acts, say });
    say();

    return { state, toggle, refresh, catalog, ...acts, pick: (s) => session.pick(s),
        drawGizmo: () => drawGizmo(ctx, state), edits: session.edits,
        setBrush: (a) => { state.brush = a; say(); } };
}
