// workui.js — the work panel: what this tab can do, what it is doing, and the
// tiles of mine that need doing.
//
// It owns no policy. ensure_job decides whether a job may be opened, claim_atom
// decides what this tab is given, and both live in the database.

import * as api from './api.js';
import { WorkLoop, probeCaps } from './work.js';

// Design 5d, the top of Work: your machine in one strip — what it can do, what
// it is doing right now, and the two switches that decide what it does with
// itself. The queue below it is client/js/renderpool.js; this is the only place
// the machine is described.
//
// What it is doing is said first and loudest, because "is my tab rendering?"
// is the only question this block is ever opened to answer.
const HTML = `
<div class="section machine">
  <div class="spread">
    <span class="label">This machine</span>
    <span class="work-gpu mono">probing…</span>
  </div>
  <div class="work-now">
    <i class="pip"></i><span class="work-state">idle</span>
  </div>
  <label class="row-switch"><span>Work in the background</span>
    <input type="checkbox" class="work-toggle"></label>
  <label class="row-switch"><span>Help render the world</span>
    <input type="checkbox" class="work-world"></label>
  <div class="work-progress note mono"></div>
  <figure class="work-view" hidden>
    <canvas width="256" height="256"></canvas>
    <figcaption class="note mono"></figcaption>
  </figure>
  <pre class="work-log note mono"></pre>
</div>`;

const LOG_LINES = 6;

// What "help render the world" claims: the cheap deterministic ops that fill in
// the baseline. Training and framing are somebody's job, not background work.
const BASELINE_OPS = ['assemble', 'sample', 'merge', 'sog'];

// A frame budget, not a frame rate: below this the tab is being played and the
// next atom waits. 33 ms is 30 fps (TASKS.md WP5.2).
const FRAME_MS = 33;
const BACKOFF_MS = 2000;

const describe = (caps) => (caps.webgpu
    ? `WebGPU · ${caps.adapter?.vendor ?? 'gpu'} · buffers to ${caps.max_buffer_mb} MB`
    : `WebGL2 only · ${caps.renderer ?? 'unknown renderer'}`);


// One line per zoom of how far the world has got. Public (db/0024_progress.sql):
// what is drawn and what is not is not a secret.
async function progressLine() {
    const rows = await api.select('progress',
        { select: 'z,tiles,published,dirty,jobs_open,atoms_ready', order: 'z' })
        .catch(() => []);
    if (!rows.length) return '';
    const total = rows.reduce((a, r) => a + Number(r.tiles), 0);
    const done = rows.reduce((a, r) => a + Number(r.published), 0);
    const ready = rows.reduce((a, r) => a + Number(r.atoms_ready), 0);
    return `${done}/${total} tiles drawn · ${ready} atoms waiting\n`
        + rows.map((r) => `z${r.z} ${r.published}/${r.tiles}`).join('  ');
}

// The loop is built once, on the first thing that needs it, because probing
// the adapter is the slowest part of mounting the panel.
async function makeLoop({ gpu, log, pace, where, world }) {
    const caps = await probeCaps();
    gpu.textContent = describe(caps);
    gpu.title = describe(caps);      // the whole of it; the strip shows an end
    return new WorkLoop({
        api, apiUrl: api.endpoints().api, filesUrl: api.endpoints().files, caps, log,
        pace, where: () => (world.checked ? where?.() ?? null : null),
    });
}

const describeState = (work) => (work?.atom
    ? `running ${work.atom.op} #${work.atom.id}`
    : `${work?.running ? 'waiting for work' : 'idle'} — `
      + `${work?.done ?? 0} done, ${work?.failed ?? 0} failed`);

// Three states, and the strip is lit for the two that mean the tab is busy.
const toneOf = (work) => (work?.atom ? 'run' : work?.running ? 'wait' : '');

// Background rendering narrows what may be claimed; chasing a bounty does not.
// Either way claim_atom decides, and it still prefers paid work.
async function onWorld(world, ready, toggle, showProgress) {
    const w = await ready();
    w.caps = world.checked
        ? { ...w.caps, ops: BASELINE_OPS }
        : { ...w.caps, ops: undefined };
    if (world.checked && !w.running) { toggle.checked = true; toggle.onchange(); }
    return showProgress();
}


// What an atom is doing, as a picture: a traced frame (webp bytes) or a
// projection of the splats it is working on (rgba), with one line under it.
export async function showPicture(view, rec) {
    const canvas = view.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const { picture: p } = rec;
    view.hidden = false;
    view.querySelector('figcaption').textContent = captionOf(rec);
    if (p.rgba) {
        canvas.width = p.width; canvas.height = p.height;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
        return;
    }
    const bitmap = await createImageBitmap(new Blob([p.webp], { type: 'image/webp' }));
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
}

export function captionOf(rec) {
    const tile = rec.tile ? `${rec.tile.z}/${rec.tile.x}/${rec.tile.y} ` : '';
    if (rec.event === 'frame') return `${tile}frame ${rec.done} of ${rec.of} traced`;
    if (rec.event === 'seeded') return `${tile}seeded: ${rec.splats} splats before training`;
    if (rec.event === 'train') {
        return `${tile}training ${rec.iter} of ${rec.of} · ${rec.splats} splats`;
    }
    if (rec.event === 'sampled') return `${tile}sampled: ${rec.splats} splats, from above`;
    return rec.event;
}

export function mountWork(host, { loop, autostart = false, frames, where } = {}) {
    host.innerHTML = HTML;
    const gpu = host.querySelector('.work-gpu');
    const toggle = host.querySelector('.work-toggle');
    const state = host.querySelector('.work-state');
    const logEl = host.querySelector('.work-log');
    const lines = [];

    // The error is the whole message when there is one: a panel that says
    // "error 1630 assemble" and nothing else is not worth reading.
    const view = host.querySelector('.work-view');
    const log = (rec) => {
        // A record with a picture is the work itself, shown rather than said.
        if (rec.picture) { showPicture(view, rec); return; }
        lines.push(`${rec.event} ${rec.atom ?? ''} ${rec.op ?? rec.state ?? ''}`.trim()
            + (rec.err ? ` — ${rec.err}` : ''));
        logEl.textContent = lines.slice(-LOG_LINES).join('\n');
        if (rec.event === 'submit' || rec.event === 'error') view.hidden = true;
        render();
    };
    const now = host.querySelector('.work-now');
    const render = () => {
        state.textContent = describeState(work);
        now.dataset.doing = toneOf(work);
    };

    let work = loop ?? null;
    const world = host.querySelector('.work-world');

    // The pace: while "help render the world" is on and the tab is drawing
    // slower than 30 fps, the next atom waits. A tab with no renderer to
    // measure (a headless worker) never waits.
    const pace = () => ((world.checked && frames && frames() > FRAME_MS) ? BACKOFF_MS : 0);

    async function ready() {
        if (!work) work = await makeLoop({ gpu, log, pace, where, world });
        return work;
    }

    const showProgress = async () => {
        host.querySelector('.work-progress').textContent = await progressLine();
    };
    world.onchange = () => onWorld(world, ready, toggle, showProgress);

    toggle.onchange = async () => {
        const w = await ready();
        if (toggle.checked) w.start(); else w.stop();
        render();
    };

    ready().then(() => { if (autostart) { toggle.checked = true; toggle.onchange(); } })
        .catch((err) => log({ event: 'probe-failed', err: String(err?.message ?? err) }));
    render();
    showProgress();
    // No refresh: the list of my dirty tiles with a Render button each is gone
    // (T6). Work reaches a tab through the pool, where it carries a price and
    // anybody can take it, rather than through a list only its owner could see.
    return { ready, loop: () => work, log, progress: showProgress,
        world: (on) => { world.checked = on; return world.onchange(); } };
}
