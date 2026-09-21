// worksettings.js — the Settings tab of Work (design 8e): the two switches that
// decide what this machine does with itself, what the machine is, how far the
// world has got at each zoom, and the log.
//
// Nodes and arithmetic only. client/js/workui.js owns the loop and wires these
// to it; nothing here decides anything.

import * as api from './api.js';

export const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

// The two switches, each with the sentence that says what it costs you. The
// design writes them as a switch over its own words rather than as a checkbox
// with a label beside it; panel.css draws a checkbox in a `.row-switch` as
// exactly that, so the control stays a checkbox and the keyboard keeps working.
const SWITCHES = [
    ['work-toggle', 'Work in the background',
        'Keep computing while this window is not in front. Several pieces at'
        + ' once — as many as the row below says — and it stands aside while'
        + ' the world is being played.'],
    ['work-world', 'Help render the world',
        'Take the deterministic pieces nobody pays for, nearest first. This is'
        + ' what fills the map in.'],
];

export function switches() {
    const node = el('div', { className: 'wk-card wk-switches' });
    const inputs = {};
    for (const [cls, name, what] of SWITCHES) {
        const input = el('input', { type: 'checkbox', className: cls });
        inputs[cls] = input;
        node.append(el('label', { className: 'row-switch wk-switch' },
            el('span', { className: 'wk-switch-text' },
                el('b', { textContent: name }),
                el('span', { className: 'note', textContent: what })),
            input));
    }
    return { node, toggle: inputs['work-toggle'], world: inputs['work-world'] };
}

// What the head of the machine card says: the renderer in four words. The
// whole of it is a paragraph, and the row below carries that.
export const shortCaps = (caps) => (caps?.webgpu
    ? `WebGPU · ${caps.adapter?.vendor ?? 'gpu'}` : 'WebGL2 only');

// What this machine is, as the design's name/value rows: what it renders with,
// how big a buffer it will hand out, and what it has done today. The last one
// is red where anything failed, because a machine that fails everything looks
// exactly like an idle one on the strip above.
//
// "Pieces at once" is a control, not a reading: it said 1 whatever the loop
// was doing, and what it is worth depends on the machine — four lanes on a
// laptop that can hold one z18's frames in memory is four lanes that swap.
export function machineRows(caps, work, onLanes = null, standing = null) {
    const rows = [
        ['Renderer', caps?.webgpu
            ? `WebGPU · ${caps.adapter?.vendor ?? 'gpu'}`
            : `WebGL2 only · ${caps?.renderer ?? 'unknown renderer'}`],
        ['Buffers', caps?.webgpu ? `up to ${caps.max_buffer_mb} MB` : 'not asked for'],
        ['Pieces at once', lanesBox(work, onLanes)],
        ['Done', String(work?.done ?? 0), 'accent'],
        ['Failed', String(work?.failed ?? 0), Number(work?.failed) > 0 ? 'bad' : ''],
        ['Standing', ...standingSaid(standing)],
    ];
    return rows.map(([k, v, tone]) => el('div', { className: 'wk-fact' },
        el('span', { textContent: k }),
        typeof v === 'string'
            ? el('span', { className: 'mono', 'data-tone': tone ?? '', title: v,
                textContent: v })
            : v));
}

// What the pool thinks of this player's worker (db/0179 my_standing): the
// trust it has and the least it needs to be handed training. A worker under
// that line is handed no training by the pool and, until this line, told
// nothing — the world looked as if it only rendered your own tiles.
export function standingSaid(standing) {
    const trust = standing?.trust == null ? NaN : Number(standing.trust);
    const need = Number(standing?.needs?.train ?? 0);
    if (!standing || !Number.isFinite(trust)) return ['not asked yet', ''];
    if (trust < need) {
        return [`trust ${trust} — under ${need}, so the pool hands this tab no`
            + ' training; pieces it finishes raise it', 'bad'];
    }
    return [`trust ${trust}`, ''];
}

// How many pieces this tab takes at once (client/js/work.js LANES). Changing
// it takes hold of the next piece each lane claims; what is in hand is left
// alone, because taking a claim off a running atom is what the world's own
// expiry is for.
export const LANE_CHOICES = [1, 2, 4, 6, 8];

function lanesBox(work, onLanes) {
    const now = Number(work?.lanes ?? 1);
    const box = el('select', { className: 'wk-lanes mono' });
    box.replaceChildren(...LANE_CHOICES.map(
        (n) => new Option(n === 1 ? 'one at a time' : `${n} at once`, String(n))));
    box.value = String(LANE_CHOICES.includes(now) ? now : LANE_CHOICES[0]);
    box.disabled = !onLanes;
    box.onchange = () => onLanes?.(Number(box.value));
    return box;
}

// One line per zoom of how far the world has got, as a bar (design 8e's "help
// render the world"). Public (db/0024_progress.sql): what is drawn and what is
// not is not a secret.
export async function zoomRows() {
    const rows = await api.select('progress',
        { select: 'z,tiles,published,dirty,jobs_open,atoms_ready', order: 'z' })
        .catch(() => []);
    return rows.map((r) => {
        const tiles = Number(r.tiles) || 0;
        const done = Number(r.published) || 0;
        const share = tiles ? Math.round((done / tiles) * 100) : 0;
        return el('div', { className: 'wk-zoom' },
            el('span', { className: 'wk-zoom-z', textContent: `z${r.z}` }),
            el('div', { className: 'wk-bar' },
                el('i', { style: `width: ${share}%` })),
            el('span', { className: 'mono', textContent: `${done} / ${tiles}` }),
            el('span', { className: 'note',
                textContent: Number(r.atoms_ready)
                    ? `${r.atoms_ready} waiting` : '' }));
    });
}

// How big a tile is built here, and what it would be built at if nobody had
// said otherwise (db/0173 world_size). A world turned down is invisible
// otherwise: `make player-run` used to leave its own numbers on the operator's
// database for good, and every tile rendered after that came out at a
// twentieth of the budget with a claim that ran out under a training run. A
// number that is not the default is said in full, with the words that put it
// back.
const SIZE_ROWS = [
    ['budget_scale', 'Splats', (v) => `${Math.round(Number(v) * 100)}% of the budget`],
    ['iters', 'Training', (v) => `${v} iterations`],
    ['frame_px', 'Frames', (v) => `${v} px`],
    ['lease', 'Claim lease', (v) => String(v)],
    ['lease_train', 'Training lease', (v) => String(v)],
];

export function sizeRows(size) {
    if (!size) return [];
    return SIZE_ROWS.map(([key, name, say]) => {
        const one = size[key] ?? {};
        const turned = Boolean(one.set) && String(one.is) !== String(one.default);
        return el('div', { className: 'wk-fact' },
            el('span', { textContent: name }),
            el('span', { className: 'mono', 'data-tone': turned ? 'bad' : '',
                textContent: say(one.is)
                    + (turned ? ` \u00b7 not ${say(one.default)}` : '') }));
    });
}

// The one sentence somebody can act on, or nothing at all when the world is
// the size it should be.
export function sizeTrouble(size) {
    const turned = SIZE_ROWS.filter(([k]) => size?.[k]?.set
        && String(size[k].is) !== String(size[k].default)).map(([k]) => k);
    if (!turned.length) return '';
    return 'This world is being built smaller than it should be. A player-run'
        + ' left its own numbers on the database; every tile rendered now comes'
        + ' out at that size. Put them back with:  '
        + turned.map((k) => `ALTER DATABASE splatworld RESET splatworld.${k};`).join('  ');
}

export async function worldSize() {
    return api.rpc('world_size').catch(() => null);
}

export async function myStanding() {
    return api.token() ? api.rpc('my_standing').catch(() => null) : null;
}

// The two numbers the strip along the top of every tab carries, from the same
// rows: what the world has drawn, and how much work is standing ready.
export async function worldLine() {
    const rows = await api.select('progress', { select: 'z,tiles,published,atoms_ready' })
        .catch(() => []);
    if (!rows.length) return '';
    const sum = (k) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
    return `${sum('published')}/${sum('tiles')} tiles drawn · ${sum('atoms_ready')}`
        + ' atoms waiting';
}

// The log block: the lines, and the three things a log offers. Follow is on
// until somebody scrolls up in it, which is what "follow" means everywhere
// else; Copy takes the whole of it, not the six lines that fit.
export function logBlock(lines) {
    const pre = el('pre', { className: 'work-log note mono' });
    const follow = el('button', { type: 'button', className: 'wk-follow',
        textContent: 'Follow' });
    follow.dataset.on = '1';
    const copy = el('button', { type: 'button', textContent: 'Copy' });
    const clear = el('button', { type: 'button', textContent: 'Clear' });
    follow.onclick = () => {
        follow.dataset.on = follow.dataset.on ? '' : '1';
        if (follow.dataset.on) pre.scrollTop = pre.scrollHeight;
    };
    copy.onclick = () => navigator.clipboard?.writeText(lines().join('\n'));
    clear.onclick = () => { lines().length = 0; pre.textContent = ''; };
    const node = el('div', { className: 'wk-card wk-log' },
        el('div', { className: 'wk-card-head' },
            el('span', { className: 'label', textContent: 'Log' }),
            el('div', { className: 'wk-acts' }, follow, copy, clear)),
        pre);
    return { node, pre, following: () => Boolean(follow.dataset.on) };
}

// The Settings tab, in the two columns the design lays it out in.
export function settingsLayout({ sw, facts, zoom, log, size }) {
    return el('div', { className: 'wk-settings' },
        el('div', { className: 'wk-col' }, sw,
            el('div', { className: 'wk-card' },
                el('div', { className: 'wk-card-head' },
                    el('span', { className: 'label',
                        textContent: 'How big this world is built' })),
                size,
                el('p', { className: 'note wk-size-trouble', hidden: true })),
            el('div', { className: 'wk-card' },
                el('div', { className: 'wk-card-head' },
                    el('span', { className: 'label', textContent: 'This machine' }),
                    el('span', { className: 'work-gpu mono' })),
                // What it is doing, said here as well as on the strip along
                // the top: this is the tab somebody opens to ask.
                el('div', { className: 'work-now' },
                    el('i', { className: 'pip' }),
                    el('span', { className: 'work-state', textContent: 'idle' })),
                facts)),
        el('div', { className: 'wk-col' },
            el('div', { className: 'wk-card' },
                el('div', { className: 'wk-card-head' },
                    el('span', { className: 'label',
                        textContent: 'Help render the world' }),
                    el('span', { className: 'work-progress mono' })),
                zoom),
            log),
        el('p', { className: 'wk-foot note',
            textContent: 'Turning both off leaves the world alone; you keep'
                + ' every tile already drawn here.' }));
}
