// workui.js — what this machine is doing, and what it does with itself.
//
// Two places, since design 8: the strip along the top of every Work tab — how
// far the world has got, what this machine can compute, and what it is doing
// right now — and the Settings tab under it, which holds the two switches, the
// machine's own facts, the world's progress by zoom and the log
// (client/js/worksettings.js draws those).
//
// It owns no policy. ensure_job decides whether a job may be opened, claim_atom
// decides what this tab is given, and both live in the database.

import * as api from './api.js';
import { WorkLoop, probeCaps } from './work.js';
import { el, logBlock, machineRows, settingsLayout, shortCaps, switches, worldLine,
    zoomRows } from './worksettings.js';

// The strip (design 8a): one line above every queue, said the same way
// whichever one is open. What the tab is doing is on the right and lit,
// because "is my tab rendering?" is the only question this is ever opened to
// answer.
function strip() {
    const node = el('div', { className: 'section machine wk-strip' },
        el('span', { className: 'label', textContent: 'This machine' }),
        el('span', { className: 'work-progress mono' }),
        el('span', { className: 'work-gpu mono', textContent: 'probing…' }),
        el('div', { className: 'work-now' },
            el('i', { className: 'pip' }),
            el('span', { className: 'work-state', textContent: 'idle' })));
    return { node, gpu: node.querySelector('.work-gpu'),
        world: node.querySelector('.work-progress'),
        now: node.querySelector('.work-now'),
        state: node.querySelector('.work-state') };
}

// What an atom is drawing, while it draws it. The cards keep a picture per
// tile of their own (client/js/poolcard.js); this is the one in hand.
function preview() {
    const node = el('figure', { className: 'work-view' },
        el('figcaption', {},
            el('span', { className: 'work-view-what mono' }),
            el('progress', { className: 'work-view-bar', max: '1', value: '0' })),
        el('canvas', { width: 256, height: 256,
            title: 'click for the full-size frame' }));
    node.hidden = true;
    return node;
}

// How many lines the log keeps, and how many of them the block shows.
const LOG_LINES = 200;
const SHOWN_LINES = 8;

// What "help render the world" claims: the cheap deterministic ops that fill in
// the baseline. Training and framing are somebody's job, not background work.
const BASELINE_OPS = ['assemble', 'merge', 'sog'];

// A frame budget, not a frame rate: below this the tab is being played and the
// next atom waits. 33 ms is 30 fps (TASKS.md WP5.2).
const FRAME_MS = 33;
const BACKOFF_MS = 2000;

const describe = (caps) => (caps.webgpu
    ? `WebGPU · ${caps.adapter?.vendor ?? 'gpu'} · buffers to ${caps.max_buffer_mb} MB`
    : `WebGL2 only · ${caps.renderer ?? 'unknown renderer'}`);


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


// One line of the log. A step says where it is and how fast; a stage says
// what brush is doing before the first step.
export function lineOf(rec) {
    if (rec.event === 'train' && rec.iter != null) {
        return `train ${rec.atom ?? ''} step ${rec.iter} of ${rec.of}`
            + (rec.per ? ` · ${rec.per} ms a step` : '')
            + (rec.maps != null ? ` · ${rec.maps} readbacks waiting ${rec.map_ms} ms`
                + ` · ${rec.submits} submits · ${rec.allocs} buffers (${rec.alloc_mb} MB)` : '');
    }
    if (rec.event === 'stage') return `train ${rec.atom ?? ''} — ${rec.text}`;
    return `${rec.event} ${rec.atom ?? ''} ${rec.op ?? rec.state ?? ''}`.trim()
        + (rec.err ? ` — ${rec.err}` : '');
}

// What an atom is doing, as a picture: a traced frame (webp bytes) or a
// projection of the splats it is working on (rgba), with one line under it.
export async function showPicture(view, rec) {
    const canvas = view.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const { picture: p } = rec;
    view.hidden = false;
    view.querySelector('.work-view-what').textContent = captionOf(rec);
    const bar = view.querySelector('.work-view-bar');
    const share = shareOf(rec);
    bar.hidden = share === null;
    if (share !== null) bar.value = share;
    if (p.rgba) {
        canvas.width = p.width; canvas.height = p.height;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
        view.full = null;
        return;
    }
    // A frame is on screen for as long as the next one takes to draw, which is
    // milliseconds: nobody can judge a picture from that. The bytes are kept
    // on the figure, and a click opens the one that is showing at full size.
    const blob = new Blob([p.webp], { type: 'image/webp' });
    view.full = blob;
    const bitmap = await createImageBitmap(blob);
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
}

// How far along the atom is, 0..1, or null when the picture is a result
// rather than a step.
export function shareOf(rec) {
    if (rec.event === 'frame' && rec.of) return rec.done / rec.of;
    if (rec.event === 'train' && rec.of) return rec.iter / rec.of;
    if (rec.event === 'seeded') return 0;
    return null;
}

export function captionOf(rec) {
    const tile = rec.tile ? `${rec.tile.z}/${rec.tile.x}/${rec.tile.y} ` : '';
    if (rec.event === 'frame') return `${tile}frame ${rec.done} of ${rec.of} traced`;
    if (rec.event === 'seeded') return `${tile}seeded: ${rec.splats} splats before training`;
    if (rec.event === 'train') {
        return `${tile}training ${rec.iter} of ${rec.of} · ${rec.splats} splats`;
    }
    // What the run actually came back with. The record has carried `splats`
    // and `of` since train-v5 and the caption fell through to the bare word
    // "trained", so the one number that says whether a tile is a picture or a
    // handful of blobs was in the log and not on the screen.
    if (rec.event === 'trained') {
        return `${tile}trained: ${rec.splats} splats kept of ${rec.of}`
            + `${rec.scale ? `, widened \u00d7${rec.scale}` : ''}`;
    }
    if (rec.event === 'sogged') {
        return `${tile}packed: ${rec.splats} splats, ${Math.round(rec.bytes / 1024)} kB`
            + `${rec.levels ? ` \u00b7 levels ${rec.levels.join('/')}` : ''}`;
    }
    // A refused submit is the run thrown away, and the rule that threw it is
    // the only thing worth saying about it (client/js/work.js broke).
    if (rec.event === 'rejected') {
        return `${rec.op} #${rec.atom} refused: the ${rec.rule} rule said no`
            + `${rec.state === 'failed' ? ', and that was the last attempt' : ''}`;
    }
    return rec.event;
}

// One record kept: a picture is shown, anything else is a line in the log and
// in the block the Settings tab draws it in.
function keep(rec, { view, lines, set }) {
    if (rec.picture) { showPicture(view, rec); return null; }
    const line = lineOf(rec);
    lines.push(line);
    if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
    const block = set()?.log;
    if (block) {
        block.pre.textContent = lines.slice(-SHOWN_LINES).join('\n');
        if (block.following()) block.pre.scrollTop = block.pre.scrollHeight;
    }
    if (rec.event === 'submit' || rec.event === 'error') view.hidden = true;
    return line;
}

// The Settings tab (design 8e), built from the parts worksettings.js draws and
// wired to the loop. The switches are the only controls on it: everything else
// is the machine and the world saying what they are.
function mountSettings(host, { ready, work, lines }) {
    const sw = switches();
    const facts = el('div', { className: 'wk-facts' });
    const zoom = el('div', { className: 'wk-zooms' });
    const log = logBlock(() => lines);
    host.append(settingsLayout({ sw: sw.node, facts, zoom, log: log.node }));
    const redraw = () => facts.replaceChildren(...machineRows(work()?.caps, work()));
    const refresh = async () => {
        host.querySelector('.wk-gpu').textContent = shortCaps(work()?.caps);
        host.querySelector('.wk-world').textContent = await worldLine();
        zoom.replaceChildren(...await zoomRows());
        redraw();
    };
    sw.toggle.onchange = async () => {
        const w = await ready();
        if (sw.toggle.checked) w.start(); else w.stop();
        redraw();
    };
    sw.world.onchange = () => onWorld(sw.world, ready, sw.toggle, refresh);
    return { ...sw, refresh, redraw, log };
}

export function mountWork(host, { loop, autostart = false, frames, where,
    settings = null } = {}) {
    const ui = strip();
    const view = preview();
    host.replaceChildren(ui.node);
    ui.node.append(view);
    view.querySelector('canvas').onclick = () => {
        if (view.full) globalThis.open?.(URL.createObjectURL(view.full), '_blank');
    };
    const lines = [];
    let work = loop ?? null;
    let set = null;

    // The error is the whole message when there is one: a panel that says
    // "error 1630 assemble" and nothing else is not worth reading.
    const listeners = new Set();
    const log = (rec) => {
        const line = keep(rec, { view, lines, set: () => set });
        for (const fn of listeners) fn(rec, line);
        render();
    };
    const render = () => {
        ui.state.textContent = describeState(work);
        ui.now.dataset.doing = toneOf(work);
        set?.redraw();
    };

    // The pace: while "help render the world" is on and the tab is drawing
    // slower than 30 fps, the next atom waits. A tab with no renderer to
    // measure (a headless worker) never waits.
    const pace = () => ((set?.world.checked && frames && frames() > FRAME_MS)
        ? BACKOFF_MS : 0);

    async function ready() {
        if (!work) {
            work = await makeLoop({ gpu: ui.gpu, log, pace, where,
                world: set?.world ?? { checked: false } });
        }
        return work;
    }

    const showProgress = async () => {
        ui.world.textContent = await worldLine();
        await set?.refresh();
    };
    if (settings) set = mountSettings(settings, { ready, work: () => work, lines });

    ready().then(() => {
        if (autostart && set) { set.toggle.checked = true; set.toggle.onchange(); }
    })
        .catch((err) => log({ event: 'probe-failed', err: String(err?.message ?? err) }));
    render();
    showProgress();
    // No refresh: the list of my dirty tiles with a Render button each is gone
    // (T6). Work reaches a tab through the pool, where it carries a price and
    // anybody can take it, rather than through a list only its owner could see.
    return { ready, loop: () => work, log, progress: showProgress, view: () => view,
        lines: () => lines,
        onLog(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        // Only where the Settings tab is mounted: the switch is a control on
        // it, not something the loop carries.
        world: (on) => {
            if (!set) return null;
            set.world.checked = on;
            return set.world.onchange();
        } };
}
