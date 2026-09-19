// flowworld.js — a World block's inspector, and the two inputs it needs.
//
// TASKS-foundation.md FND.14. The five World blocks (client/flow/world) take
// an object's id, a port's name and a value, all as plain strings, because
// strings are what the ELX carries. Typing one by hand means typing a uuid, so
// the inspector offers the land's objects by name, the chosen object's product
// ports by name (FND.6, db/0160), and a widget for whatever kind of port it
// is. And a flow that reaches into the world is given `world` and `world_key`
// to reach it with, which cannot be taken away while a World block is there.

import { el } from './poolui.js';
import { markGraphDirty } from '../flow/graph/history.js';

export const WORLD_PLUGIN = 'world';

// Every flow gets these two, and keeps them while a World block is in it: they
// are the address the block writes to and the login it writes as.
export const WORLD_INPUTS = ['world', 'world_key'];

const OBJECT = 'Object';
const PORT = 'Port';
const VALUE = 'Value';

// The three the World section answers for. Everything else a World block takes
// — the world's url, its key, a mover's fields — is a constant like any other,
// so the generic list keeps them.
export const WORLD_PORTS = new Set([OBJECT, PORT, VALUE]);

export const isWorldBlock = (node) => node?._irPlugin === WORLD_PLUGIN;

export const usesWorld = (graph) => (graph?._nodes ?? []).some(isWorldBlock);

// What a block has typed onto one of its inputs, and how to type it. The shape
// is the ELX's own, the one flowinspector.js writes for every other constant.
export function constantOf(node, port) {
    return node._irConstants?.find((c) => c.port === port)?.value?.value?.data ?? '';
}

export function setConstant(node, port, text) {
    node._irConstants = (node._irConstants ?? []).filter((c) => c.port !== port);
    node._irConstants.push(text === ''
        ? { port }
        : { port, value: { structure: 'droplet', value: { id: 'string', data: text } } });
    markGraphDirty(node.graph);
}

// What a port may be set to (db/0160 check_ports says which five there are).
export function widgetFor(type) {
    if (type === 'boolean') return 'boolean';
    if (type === 'number') return 'number';
    if (type === 'colour') return 'colour';
    return 'text';
}

export const missingWorldInputs = (graph) => {
    const have = new Set((graph?._nodes ?? [])
        .filter((n) => n._irKind === 'pseudo-input').map((n) => n._irName));
    return WORLD_INPUTS.filter((name) => !have.has(name));
};

// Given to a flow the moment it is made, so a World block dropped into it has
// something to wire to rather than two ports to remember to add.
export function addWorldInputs(canvas) {
    const added = [];
    for (const name of missingWorldInputs(canvas.graph)) {
        const node = canvas.addPseudo('input');
        node._irName = name;
        node.title = name;
        node._irStructure = { structure: 'droplet', value: { id: 'string', data: '' } };
        added.push(name);
    }
    if (added.length) markGraphDirty(canvas.graph);
    return added;
}

// ------------------------------------------------------------------ the rows

const slotsOf = (node) => new Set((node.inputs ?? []).map((s) => s.name));

function objectField(node, found, world, changed) {
    const sel = el('select', { className: 'fl-object' });
    sel.append(el('option', { value: '',
        textContent: found.length ? 'nothing yet' : 'nothing on this land yet' }));
    for (const o of found) sel.append(el('option', { value: o.id, textContent: o.name }));
    sel.value = constantOf(node, OBJECT);
    sel.onchange = () => { setConstant(node, OBJECT, sel.value); changed(); };
    const pick = el('button', { type: 'button', className: 'fl-pick',
        textContent: 'Pick in world' });
    pick.onclick = async () => {
        const got = await world.pick?.();
        if (!got?.id) return;
        setConstant(node, OBJECT, got.id);
        changed();
    };
    return [sel, pick];
}

function portField(node, ports, changed) {
    const sel = el('select', { className: 'fl-port' });
    sel.append(el('option', { value: '',
        textContent: ports.length ? 'nothing yet' : 'this product has no ports' }));
    for (const p of ports) {
        sel.append(el('option', { value: p.name, textContent: `${p.name} · ${p.type}` }));
    }
    sel.value = constantOf(node, PORT);
    sel.onchange = () => { setConstant(node, PORT, sel.value); changed(); };
    return sel;
}

// The value, in whatever the port is. A switch writes "true" or "false", a
// colour writes "#rrggbb": strings both, because that is what goes in the ELX.
function valueField(node, port, changed) {
    const kind = widgetFor(port?.type);
    const was = constantOf(node, VALUE);
    if (kind === 'boolean') {
        const box = el('input', { type: 'checkbox', className: 'fl-value',
            checked: was === 'true' });
        box.onchange = () => {
            setConstant(node, VALUE, box.checked ? 'true' : 'false');
            changed();
        };
        return box;
    }
    const type = kind === 'number' ? 'number' : kind === 'colour' ? 'color' : 'text';
    const input = el('input', { type, className: 'fl-value',
        value: kind === 'colour' ? (was || '#ffffff') : was });
    input.onchange = () => { setConstant(node, VALUE, input.value); changed(); };
    return input;
}

function fill(node, list, found, world, changed) {
    const chosen = found.find((o) => o.id === constantOf(node, OBJECT)) ?? null;
    const ports = chosen?.ports ?? [];
    const row = (port) => list.querySelector(`li[data-port="${port}"]`);
    row(OBJECT)?.replaceChildren(el('span', { textContent: OBJECT }),
        ...objectField(node, found, world, changed));
    row(PORT)?.replaceChildren(el('span', { textContent: PORT }),
        portField(node, ports, changed));
    row(VALUE)?.replaceChildren(el('span', { textContent: VALUE }),
        valueField(node, ports.find((p) => p.name === constantOf(node, PORT)), changed));
}

// The World section of the inspector. The land's objects are asked for as this
// is drawn and the rows are filled when the answer arrives — the inspector is
// redrawn on every change, so there is nothing to keep in the meantime.
export function worldFields(node, world, changed) {
    const slots = slotsOf(node);
    if (!world || !slots.has(OBJECT)) return [];
    const list = el('ul', { className: 'fl-world' });
    for (const port of [OBJECT, PORT, VALUE]) {
        if (!slots.has(port)) continue;
        const li = el('li', {}, el('span', { textContent: port }),
            el('span', { className: 'muted', textContent: 'asking the world…' }));
        li.dataset.port = port;
        list.append(li);
    }
    Promise.resolve(world.objects?.() ?? []).then(
        (found) => fill(node, list, found, world, changed),
        () => fill(node, list, [], world, changed));
    return [el('h3', { textContent: 'World' }), list];
}
