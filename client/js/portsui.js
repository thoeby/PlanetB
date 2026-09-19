// portsui.js — the Ports section of the Place panel (FND.15).
//
// What a selected thing can be told, from the product's own port list
// (db/0160), with a widget for whatever kind each port is: a switch, a number,
// a line of text, a colour, or a picture out of the catalog. A change takes at
// once — `port_write` is one row and one rev (db/0169) — except a screen,
// which waits for the land's approver before anybody else sees it (D13).
//
// Somebody who may not build here is shown the same list, and cannot touch it:
// the page says so, and the database says so again (Invariant 6).

import * as api from './api.js';
import { el } from './poolui.js';
import { searchAssets } from './catalog.js';

const TRUE = new Set(['true', '1', 'yes', true, 1]);

const words = (port) => `${port.name} · ${port.type}`;

// What the world last recorded for this port, or what the product says it
// starts out as.
const now = (state, port) => {
    const said = state.live?.[port.name]?.value;
    return said === undefined || said === null ? port.default : said;
};

// A picture is picked off the catalog by name, not typed as a sha256.
function picture(state, port, set) {
    const search = el('input', { type: 'search', className: 'pt-picture',
        placeholder: 'a material from the catalog' });
    const found = el('ul', { className: 'pt-found rows' });
    search.onchange = async () => {
        const rows = await searchAssets({ search: search.value, type: 'material',
            limit: 6 }).catch(() => []);
        found.replaceChildren(...rows.map((a) => {
            const b = el('button', { type: 'button', textContent: a.name });
            b.onclick = () => set(a.sha256);
            return el('li', { className: 'pt-material' }, b);
        }));
    };
    return el('div', { className: 'pt-image' }, search, found);
}

// The widget a port of that kind gets, and what it writes.
function field(state, port, set) {
    const value = now(state, port);
    if (port.type === 'boolean') {
        const box = el('input', { type: 'checkbox', className: 'pt-value',
            checked: TRUE.has(value) });
        box.onchange = () => set(box.checked);
        return box;
    }
    if (port.type === 'number') {
        const input = el('input', { type: 'number', className: 'pt-value',
            value: Number(value ?? 0) });
        input.onchange = () => set(Number(input.value));
        return input;
    }
    if (port.type === 'colour') {
        const input = el('input', { type: 'color', className: 'pt-value',
            value: /^#[0-9a-f]{6}$/i.test(String(value ?? '')) ? value : '#ffd9a0' });
        input.onchange = () => set(input.value);
        return input;
    }
    if (port.type === 'image') return picture(state, port, set);
    const input = el('input', { type: 'text', className: 'pt-value',
        value: value ?? '' });
    input.onchange = () => set(input.value);
    return input;
}

// One port's line: what it is, what it is set to, and — for a screen — what is
// waiting on somebody else's word.
function row(state, port, on) {
    const li = el('li', { className: 'pt-port' });
    li.dataset.port = port.name;
    const set = async (value) => {
        try {
            const done = await api.rpc('port_write',
                { p_instance: state.id, p_port: port.name, p_value: value });
            on.wrote(state.id, port.name, done);
            // Read it back: a screen that is waiting has to say so on its own
            // row, not only in the line under the list.
            await on.reload();
            on.say(done.waiting
                ? `${port.name}: shown to others after approval`
                : `${port.name} set`);
        } catch (err) {
            on.say(String(err.body?.message ?? err.message ?? err), true);
        }
    };
    const input = field(state, port, set);
    if (!state.mine) {
        for (const e of [input, ...input.querySelectorAll?.('input, button') ?? []]) {
            if ('disabled' in e) e.disabled = true;
        }
    }
    const waiting = state.live?.[port.name]?.pending;
    li.append(el('span', { className: 'pt-name', textContent: words(port) }), input,
        waiting ? el('span', { className: 'pt-waiting muted',
            textContent: 'waiting for approval' }) : null);
    return li;
}

export function mountPorts(host, on = {}) {
    const section = host.querySelector('.build-ports-section');
    const list = host.querySelector('.build-ports');
    const said = host.querySelector('.build-ports-said');
    const state = { id: null, ports: [], live: {}, mine: false };
    const say = (text, bad = false) => {
        said.textContent = text;
        said.dataset.bad = bad ? '1' : '';
    };

    async function show(row_, asset) {
        const ports = asset?.parts?.ports ?? [];
        state.id = row_?.id ?? null;
        state.ports = ports;
        state.mine = Boolean(row_?.mine);
        section.hidden = !state.id || !ports.length;
        if (section.hidden) { list.replaceChildren(); return; }
        state.live = await api.rpc('live_of', { p_instance: state.id })
            .catch(() => ({}));
        draw();
    }

    async function reload() {
        if (!state.id) return;
        state.live = await api.rpc('live_of', { p_instance: state.id })
            .catch(() => ({}));
        draw();
    }

    function draw() {
        list.replaceChildren(...state.ports.map((p) => row(state, p,
            { say, reload, wrote: on.wrote ?? (() => {}) })));
        if (!state.mine) say('You may not build here, so these are read-only.');
        else say('');
    }

    return { node: section, show, said: () => said.textContent,
        redraw: draw, reload, state };
}
