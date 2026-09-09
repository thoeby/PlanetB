// workui.js — the work panel: what this tab can do, what it is doing, and the
// tiles of mine that need doing.
//
// It owns no policy. ensure_job decides whether a job may be opened, claim_atom
// decides what this tab is given, and both live in the database.

import * as api from './api.js';
import { WorkLoop, probeCaps } from './work.js';

const HTML = `
<div class="work-gpu">probing…</div>
<label class="work-bg"><input type="checkbox" class="work-toggle"> work in the background</label>
<label class="work-bg"><input type="checkbox" class="work-world">
  help render the world</label>
<div class="work-state">idle</div>
<div class="work-progress muted"></div>
<ul class="work-tiles"></ul>
<pre class="work-log"></pre>`;

const LOG_LINES = 6;

// What "help render the world" claims: the cheap deterministic ops that fill in
// the baseline. Training and framing are somebody's job, not background work.
const BASELINE_OPS = ['assemble', 'sample', 'merge', 'sog'];

// A frame budget, not a frame rate: below this the tab is being played and the
// next atom waits. 33 ms is 30 fps (TASKS.md WP5.2).
const FRAME_MS = 33;
const BACKOFF_MS = 2000;

const describe = (caps) => (caps.webgpu
    ? `WebGPU · ${caps.adapter?.vendor ?? 'gpu'} · ~${caps.vram_gb} GB (estimated)`
    : `WebGL2 only · ${caps.renderer ?? 'unknown renderer'}`);

function tileRow(t, onRender) {
    const li = document.createElement('li');
    li.className = 'work-tile';
    li.textContent = `${t.z}/${t.x}/${t.y} v${t.expected_version} `;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.job_id ? `job ${t.job_id}` : 'render';
    b.onclick = () => onRender(t, b);
    li.append(b);
    return li;
}

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
    return new WorkLoop({
        api, apiUrl: api.endpoints().api, filesUrl: api.endpoints().files, caps, log,
        pace, where: () => (world.checked ? where?.() ?? null : null),
    });
}

const describeState = (work) => (work?.atom
    ? `running ${work.atom.op} #${work.atom.id}`
    : `${work?.running ? 'waiting for work' : 'idle'} — `
      + `${work?.done ?? 0} done, ${work?.failed ?? 0} failed`);

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

export function mountWork(host, { loop, autostart = false, frames, where } = {}) {
    host.innerHTML = HTML;
    const gpu = host.querySelector('.work-gpu');
    const toggle = host.querySelector('.work-toggle');
    const state = host.querySelector('.work-state');
    const list = host.querySelector('.work-tiles');
    const logEl = host.querySelector('.work-log');
    const lines = [];

    // The error is the whole message when there is one: a panel that says
    // "error 1630 assemble" and nothing else is not worth reading.
    const log = (rec) => {
        lines.push(`${rec.event} ${rec.atom ?? ''} ${rec.op ?? rec.state ?? ''}`.trim()
            + (rec.err ? ` — ${rec.err}` : ''));
        logEl.textContent = lines.slice(-LOG_LINES).join('\n');
        render();
    };
    const render = () => { state.textContent = describeState(work); };

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

    // My dirty tiles, and one button each to open the job for them. Opening a
    // job creates no work for this tab in particular — any worker may claim it.
    async function refresh() {
        if (!api.token()) { list.replaceChildren(); return; }
        const tiles = await api.rpc('my_dirty_tiles', { p_limit: 20 }).catch(() => []);
        list.replaceChildren(...tiles.map((t) => tileRow(t, onRender)));
    }

    async function onRender(tile, btn) {
        btn.disabled = true;
        const job = await api.rpc('ensure_job', { z: tile.z, x: tile.x, y: tile.y });
        btn.textContent = `job ${job}`;
        log({ event: 'ensure_job', atom: `${tile.z}/${tile.x}/${tile.y}`, op: job });
        if (!work?.running) { toggle.checked = true; toggle.onchange(); }
    }

    ready().then(() => { if (autostart) { toggle.checked = true; toggle.onchange(); } });
    render();
    showProgress();
    return { refresh, ready, loop: () => work, log, progress: showProgress,
        world: (on) => { world.checked = on; return world.onchange(); } };
}
