// assignform.js — the nodes of Survey's Land panel: the strip over the map,
// and the three boxes the panel is made of.
//
// Split out of client/js/assignland.js when that file passed the four hundred
// lines CLAUDE.md allows. Nodes only: assignland.js wires them and decides
// everything.

import { MAP } from './landmap.js';

const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
};

// The strip over the map: which of its two jobs it is doing, and how far in it
// is looking. A coverage is tens of kilometres and the land on it is a few
// hundred metres, so there has to be a way in.
export function mapControls() {
    const mode = el('div', { className: 'row lm-mode' });
    const buttons = new Map();
    for (const [key, label] of [['draw', 'Draw'], ['pick', 'Pick']]) {
        const b = el('button', { type: 'button', textContent: label });
        b.dataset.mode = key;
        buttons.set(key, b);
        mode.append(b);
    }
    const zoom = el('div', { className: 'row lm-zoom' });
    const zooms = new Map();
    for (const [key, label, title] of [['out', '−', 'zoom out'],
        ['in', '+', 'zoom in'], ['fit', 'Fit', 'the whole world']]) {
        const b = el('button', { type: 'button', textContent: label, title });
        b.dataset.zoom = key;
        zooms.set(key, b);
        zoom.append(b);
    }
    const scale = el('span', { className: 'lm-scale muted mono' });
    return { node: el('div', { className: 'spread lm-bar' }, mode, zoom, scale),
        buttons, zooms, scale };
}

// The panel, as the design lays it out: who is waiting, the map, what was
// drawn as numbers, and the name it will be called.
export function build(host) {
    const canvas = el('canvas', { id: 'assign-map', width: MAP.w, height: MAP.h });
    const controls = mapControls();
    const requests = el('div', { className: 'rows assign-requests' });
    const boundary = el('textarea', { id: 'assign-boundary', rows: 5,
        placeholder: 'one "longitude, latitude" per line' });
    const nameField = el('input', { type: 'text', id: 'assign-name',
        placeholder: 'Ben’s field' });
    const finish = el('button', { type: 'button',
        textContent: 'Finish the boundary' });
    const clear = el('button', { type: 'button', textContent: 'Start again' });
    const assign = el('button', { type: 'button', className: 'primary',
        textContent: 'Assign this land' });
    const status = el('p', { className: 'status assign-status' });
    const picked = el('div', { className: 'picked' });
    const landStatus = el('p', { className: 'status land-drop-status' });
    // Three boxes, so that Survey — where this map is the whole workspace —
    // can put the map beside the form rather than in the middle of it
    // (client/panels.css). In a column they simply follow one another, which
    // is the order they were always in.
    host.append(el('div', { className: 'assign-side' },
        el('div', { className: 'section assign' },
            el('span', { className: 'label', textContent: 'Land requests' }),
            requests,
            el('label', { htmlFor: 'assign-boundary', textContent: 'boundary' }),
            boundary,
            el('label', { htmlFor: 'assign-name', textContent: 'name this land' }),
            nameField, assign, status),
        el('div', { className: 'section picked-box' },
            el('span', { className: 'label', textContent: 'The land you picked' }),
            picked, landStatus)));
    host.append(el('div', { className: 'section assign-map' },
        el('span', { className: 'label', textContent: 'The ground' }),
        el('p', { className: 'muted',
            textContent: 'Drag the map to move it, + and − to go in and'
                + ' out. Draw puts corners down; Pick selects the land you'
                + ' click on.' }),
        controls.node,
        el('div', { className: 'assign-canvas' }, canvas),
        el('div', { className: 'row' }, finish, clear)));

    return { canvas, controls, requests, boundary, nameField, finish, clear,
        assign, status, picked, landStatus };
}
