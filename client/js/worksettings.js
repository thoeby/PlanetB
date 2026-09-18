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
        'Keep computing while this window is not in front. One job at a time,'
        + ' and it stands aside while the world is being played.'],
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
export function machineRows(caps, work) {
    const rows = [
        ['Renderer', caps?.webgpu
            ? `WebGPU · ${caps.adapter?.vendor ?? 'gpu'}`
            : `WebGL2 only · ${caps?.renderer ?? 'unknown renderer'}`],
        ['Buffers', caps?.webgpu ? `up to ${caps.max_buffer_mb} MB` : 'not asked for'],
        ['Jobs at once', '1'],
        ['Done', String(work?.done ?? 0), 'accent'],
        ['Failed', String(work?.failed ?? 0), Number(work?.failed) > 0 ? 'bad' : ''],
    ];
    return rows.map(([k, v, tone]) => el('div', { className: 'wk-fact' },
        el('span', { textContent: k }),
        el('span', { className: 'mono', 'data-tone': tone ?? '', title: v,
            textContent: v })));
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
export function settingsLayout({ sw, facts, zoom, log }) {
    return el('div', { className: 'wk-settings' },
        el('div', { className: 'wk-col' }, sw,
            el('div', { className: 'wk-card' },
                el('div', { className: 'wk-card-head' },
                    el('span', { className: 'label', textContent: 'This machine' }),
                    el('span', { className: 'wk-gpu mono' })),
                facts)),
        el('div', { className: 'wk-col' },
            el('div', { className: 'wk-card' },
                el('div', { className: 'wk-card-head' },
                    el('span', { className: 'label',
                        textContent: 'Help render the world' }),
                    el('span', { className: 'wk-world mono' })),
                zoom),
            log),
        el('p', { className: 'wk-foot note',
            textContent: 'Turning both off leaves the world alone; you keep'
                + ' every tile already drawn here.' }));
}
