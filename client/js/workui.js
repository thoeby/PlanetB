// workui.js — what this machine is doing, and what it does with itself.
//
// What it is doing is said on the strip along the top of the page
// (client/js/topbar.js), because it is true wherever you are looking: the Work
// panel is then nothing but its queues. What it does with itself — the two
// switches, the machine's own facts, the world's progress by zoom and the log
// — is the Settings tab of Work (client/js/worksettings.js draws those).
//
// It owns no policy. ensure_job decides whether a job may be opened, claim_atom
// decides what this tab is given, and both live in the database.

import * as api from './api.js';
import { WorkLoop, probeCaps } from './work.js';
import { el, logBlock, machineRows, myStanding, settingsLayout, shortCaps, sizeRows,
    sizeTrouble,
    switches, worldLine, worldSize, zoomRows } from './worksettings.js';

// How many lines the log keeps, and how many of them the block shows.
const LOG_LINES = 200;
const SHOWN_LINES = 8;

// What "help render the world" claims: the deterministic ops that fill in
// the baseline. Training is somebody's job, not background work.
const BASELINE_OPS = ['dataset', 'merge', 'sog'];

// A frame budget, not a frame rate: below this the tab is being played and the
// next atom waits. 33 ms is 30 fps (TASKS.md WP5.2).
const FRAME_MS = 33;
const BACKOFF_MS = 2000;

const describe = (caps) => (caps.webgpu
    ? `WebGPU · ${caps.adapter?.vendor ?? 'gpu'} · buffers to ${caps.max_buffer_mb} MB`
    : `WebGL2 only · ${caps.renderer ?? 'unknown renderer'}`);


// The loop is built once, on the first thing that needs it, because probing
// the adapter is the slowest part of mounting the panel.
async function makeLoop({ log, pace, where, world }) {
    const caps = await probeCaps();
    return new WorkLoop({
        api, apiUrl: api.endpoints().api, filesUrl: api.endpoints().files, caps, log,
        pace, where: () => (world.checked ? where?.() ?? null : null),
    });
}

// What the machine is doing, in one line. How many pieces, not which one: a
// tab holds up to four of them (client/js/work.js LANES), and naming the one
// that happened to be claimed last said the tab was doing a quarter of it.
const describeState = (work) => {
    const held = [...(work?.working?.values() ?? [])];
    if (!held.length) {
        return `${work?.running ? 'waiting for work' : 'idle'} — `
            + `${work?.done ?? 0} done, ${work?.failed ?? 0} failed`;
    }
    const ops = [...new Set(held.map((a) => a.op))].join(' · ');
    return held.length === 1 ? `running ${held[0].op} #${held[0].id}`
        : `running ${held.length} pieces — ${ops}`;
};

// Three states, and the strip is lit for the two that mean the tab is busy.
const toneOf = (work) => (work?.working?.size ? 'run' : work?.running ? 'wait' : '');

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

// One record kept: a picture belongs to the card of the tile it is of, and the
// loop keeps those itself (client/js/work.js pictures, client/js/poolcard.js);
// anything else is a line in the log and in the block the Settings tab draws.
function keep(rec, { lines, set }) {
    if (rec.picture) return null;
    const line = lineOf(rec);
    lines.push(line);
    if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
    const block = set()?.log;
    if (block) {
        block.pre.textContent = lines.slice(-SHOWN_LINES).join('\n');
        if (block.following()) block.pre.scrollTop = block.pre.scrollHeight;
    }
    return line;
}

// The Settings tab (design 8e), built from the parts worksettings.js draws and
// wired to the loop. The switches are the only controls on it: everything else
// is the machine and the world saying what they are.
function mountSettings(host, { ready, work, lines }) {
    const sw = switches();
    const facts = el('div', { className: 'wk-facts' });
    const size = el('div', { className: 'wk-facts wk-size' });
    const zoom = el('div', { className: 'wk-zooms' });
    const log = logBlock(() => lines);
    host.append(settingsLayout({ sw: sw.node, facts, size, zoom, log: log.node }));
    // How many pieces this tab takes at once. The loop reads it on the next
    // claim of each lane, so what is in hand is left alone.
    const setLanes = async (n) => {
        const w = await ready();
        w.lanes = n;
        if (w.running) { w.stop(); w.start(); }
        redraw();
    };
    let standing = null;
    const redraw = () => facts.replaceChildren(
        ...machineRows(work()?.caps, work(), work() ? setLanes : null, standing));
    const refresh = async () => {
        const gpu = host.querySelector('.work-gpu');
        gpu.textContent = shortCaps(work()?.caps);
        gpu.title = describe(work()?.caps ?? {});
        host.querySelector('.work-progress').textContent = await worldLine();
        zoom.replaceChildren(...await zoomRows());
        // How big a tile is built here (db/0173). A world left turned down by
        // a player-run renders every tile at a twentieth of the budget and
        // said nothing about it until this line.
        const how = await worldSize();
        size.replaceChildren(...sizeRows(how));
        standing = await myStanding();
        redraw();
        const bad = host.querySelector('.wk-size-trouble');
        bad.textContent = sizeTrouble(how);
        bad.hidden = !bad.textContent;
        bad.dataset.bad = bad.textContent ? '1' : '';
        redraw();
    };
    // What the machine is doing, on the tab that is about the machine.
    const said = (text, tone) => {
        host.querySelector('.work-state').textContent = text;
        host.querySelector('.work-now').dataset.doing = tone ?? '';
    };
    sw.toggle.onchange = async () => {
        const w = await ready();
        if (sw.toggle.checked) w.start(); else w.stop();
        redraw();
    };
    sw.world.onchange = () => onWorld(sw.world, ready, sw.toggle, refresh);
    return { ...sw, refresh, redraw, said, log };
}

export function mountWork({ loop, autostart = false, frames, where,
    settings = null, onState = () => {} } = {}) {
    const lines = [];
    let work = loop ?? null;
    let set = null;
    // The tile the atom in hand is about, as the atom itself said it: a frame
    // or a training step names the tile it is of, and the map draws where this
    // machine is working (client/js/hudmap.js). It goes when the atom does.
    let tile = null;

    // The error is the whole message when there is one: a panel that says
    // "error 1630 assemble" and nothing else is not worth reading.
    const listeners = new Set();
    const log = (rec) => {
        if (rec.tile) tile = rec.tile;
        if (rec.event === 'submit' || rec.event === 'error') tile = null;
        const line = keep(rec, { lines, set: () => set });
        for (const fn of listeners) fn(rec, line);
        render();
    };
    // Said twice, in the two places it belongs: on the strip along the top
    // while the tab is busy at all, and on the Settings tab whatever it is
    // doing — that tab is where somebody goes to ask.
    const render = () => {
        const said = describeState(work);
        const tone = toneOf(work);
        onState(tone ? said : '', tone);
        set?.said(said, tone);
        set?.redraw();
    };

    // The pace: while "help render the world" is on and the tab is drawing
    // slower than 30 fps, the next atom waits. A tab with no renderer to
    // measure (a headless worker) never waits.
    const pace = () => ((set?.world.checked && frames && frames() > FRAME_MS)
        ? BACKOFF_MS : 0);

    async function ready() {
        if (!work) {
            work = await makeLoop({ log, pace, where,
                world: set?.world ?? { checked: false } });
            set?.refresh();
        }
        return work;
    }

    const showProgress = async () => { await set?.refresh(); };
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
    return { ready, loop: () => work, log, progress: showProgress,
        lines: () => lines,
        // Which tile this machine is working on, or null when it is not.
        tile: () => (work?.atom ? tile : null),
        onLog(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        // Only where the Settings tab is mounted: the switch is a control on
        // it, not something the loop carries.
        world: (on) => {
            if (!set) return null;
            set.world.checked = on;
            return set.world.onchange();
        } };
}
