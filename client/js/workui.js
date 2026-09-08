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
<div class="work-state">idle</div>
<ul class="work-tiles"></ul>
<pre class="work-log"></pre>`;

const LOG_LINES = 6;

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

export function mountWork(host, { loop, autostart = false } = {}) {
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
    const render = () => {
        state.textContent = work?.atom
            ? `running ${work.atom.op} #${work.atom.id}`
            : `${work?.running ? 'waiting for work' : 'idle'} — `
              + `${work?.done ?? 0} done, ${work?.failed ?? 0} failed`;
    };

    let work = loop ?? null;

    async function ready() {
        if (work) return work;
        const caps = await probeCaps();
        gpu.textContent = describe(caps);
        work = new WorkLoop({
            api, apiUrl: api.endpoints().api, filesUrl: api.endpoints().files, caps, log,
        });
        return work;
    }

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
        list.replaceChildren(...tiles.map((t) => tileRow(t, async (tile, btn) => {
            btn.disabled = true;
            const job = await api.rpc('ensure_job',
                { z: tile.z, x: tile.x, y: tile.y });
            btn.textContent = `job ${job}`;
            log({ event: 'ensure_job', atom: `${tile.z}/${tile.x}/${tile.y}`, op: job });
            if (!work?.running) { toggle.checked = true; toggle.onchange(); }
        })));
    }

    ready().then(() => { if (autostart) { toggle.checked = true; toggle.onchange(); } });
    render();
    return { refresh, ready, loop: () => work, log };
}
