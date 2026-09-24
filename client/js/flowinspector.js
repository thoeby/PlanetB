// flowinspector.js — the right column of the Automate view.
//
// With a block selected: what it is called, what its parameters are set to,
// what is typed into its unwired inputs, and how many slots a repeatable port
// has. With nothing selected: the flow's own inputs and outputs, which are what
// somebody calling this flow passes in and gets back (SPEC §2.16).

import { el } from './poolui.js';
import { addPort, removePort } from '../flow/graph/portgroup.js';
import { getBlock } from '../flow/plugins/registry.js';
import { markGraphDirty } from '../flow/graph/history.js';
import { isWorldBlock, usesWorld, worldFields, WORLD_INPUTS, WORLD_PORTS }
    from './flowworld.js';

const TRUE = new Set(['true', '1', 'yes']);

// What a flow's own input or output carries. The vocabulary is the plugins':
// a literal's `id` in the ELX. "anything" is a pseudo-node with no baked-in
// structure at all, which is what the format means by leaving it out.
const PORT_TYPES = ['anything', 'string', 'boolean', 'integer', 'json'];

// A parameter's widget is chosen by what the block says it holds: a boolean is
// a switch, an integer a number, anything else a line of text.
export function widgetKind(def) {
    const type = (def?.default?.type ?? def?.type ?? '').toLowerCase();
    if (type === 'boolean' || type === 'bool') return 'boolean';
    if (type === 'integer' || type === 'int' || type === 'number') return 'number';
    if (def?.choices?.length) return 'choice';
    return 'text';
}

function field(def, value, onSet) {
    const kind = widgetKind(def);
    if (kind === 'boolean') {
        const box = el('input', { type: 'checkbox', checked: TRUE.has(String(value)) });
        box.onchange = () => onSet(box.checked ? 'true' : 'false');
        return box;
    }
    if (kind === 'choice') {
        const sel = el('select');
        for (const c of def.choices) {
            sel.append(el('option', { value: c.data, textContent: c.label ?? c.data }));
        }
        sel.value = String(value ?? '');
        sel.onchange = () => onSet(sel.value);
        return sel;
    }
    const input = el('input', { type: kind === 'number' ? 'number' : 'text',
        value: value ?? '' });
    input.onchange = () => onSet(input.value);
    if (kind !== 'number') return input;
    // Design 10a: a number is a stepper, − and + either side of it.
    const step = (d) => () => {
        input.value = String((Number(input.value) || 0) + d);
        onSet(input.value);
    };
    const less = el('button', { type: 'button', className: 'fl-step', textContent: '\u2212' });
    const more = el('button', { type: 'button', className: 'fl-step', textContent: '+' });
    less.setAttribute('aria-label', 'less');
    more.setAttribute('aria-label', 'more');
    less.onclick = step(-1);
    more.onclick = step(1);
    return el('span', { className: 'fl-stepper' }, less, input, more);
}

const paramValue = (node, id) => node.properties?.[id]
    ?? node._irParameters?.find((p) => p.id === id)?.value?.value ?? '';

// A block's parameters, as the plugin declares them.
function parameters(node, changed) {
    const block = getBlock(node._irPlugin, node._irNodeId);
    if (!block?.parameters?.length) return [];
    const list = el('ul', { className: 'fl-params' });
    for (const def of block.parameters) {
        const row = el('li', {});
        row.dataset.param = def.id;
        row.append(el('span', { textContent: def.name || def.id }),
            field(def, paramValue(node, def.id), (v) => {
                node.properties = node.properties ?? {};
                node.properties[def.id] = v;
                markGraphDirty(node.graph);
                changed();
            }));
        list.append(row);
    }
    return [el('section', { className: 'fl-isec' },
        el('h3', { textContent: 'Parameters' }), list)];
}

// A value typed straight onto an input that no wire reaches. Wired inputs take
// what the wire brings, so they are not offered one.
// Design 10a: a wired input is listed too, as where its value comes from.
function wiredRow(node, slot) {
    const link = node.graph?.links?.[slot.link];
    const from = link ? node.graph.getNodeById(link.origin_id) : null;
    const row = el('li', { className: 'fl-wired' },
        el('span', { textContent: slot.label ?? slot.name }),
        el('span', { className: 'fl-wire-from',
            textContent: `wired \u00b7 from ${from?._irName ?? from?.title ?? 'a block'}` }));
    row.dataset.wired = slot.name;
    return row;
}

function constants(node, changed, held = new Set()) {
    const open = (slot) => slot.link === null || slot.link === undefined;
    const all = (node.inputs ?? []).filter((slot) => !held.has(slot.name));
    const rows = all.filter(open).map((slot) => ({ slot }));
    if (!all.length) return [];
    const list = el('ul', { className: 'fl-consts' });
    for (const slot of all.filter((x) => !open(x))) list.append(wiredRow(node, slot));
    for (const { slot } of rows) {
        const was = node._irConstants?.find((c) => c.port === slot.name);
        const row = el('li', {});
        row.dataset.port = slot.name;
        row.append(el('span', { textContent: slot.label ?? slot.name }),
            field({}, was?.value?.value?.data ?? '', (v) => {
                node._irConstants = (node._irConstants ?? [])
                    .filter((c) => c.port !== slot.name);
                // The ELX shape: `<constant port="…"><structure id="droplet">
                // <value id="string">…</value></structure></constant>`. An
                // empty one is a port deliberately left unconnected, which is
                // a different thing from no constant at all, so it keeps its
                // row with no `<structure>` inside.
                node._irConstants.push(v === ''
                    ? { port: slot.name }
                    : { port: slot.name,
                        value: { structure: 'droplet', value: { id: 'string', data: v } } });
                markGraphDirty(node.graph);
                changed();
            }));
        list.append(row);
    }
    return [el('section', { className: 'fl-isec' },
        el('h3', { textContent: 'Constants' }), list)];
}

// How many slots a repeatable port has. The block says how few it may have;
// a slot with a wire in it is not taken away underneath the wire.
function portGroups(node, changed) {
    if (!node._portGroups?.length) return [];
    const list = el('ul', { className: 'fl-groups' });
    for (const state of node._portGroups) {
        const count = el('span', { className: 'mono', textContent: String(state.size) });
        const plus = el('button', { type: 'button', textContent: '+' });
        const minus = el('button', { type: 'button', textContent: '−' });
        const after = (n) => {
            if (n < 0) return;
            count.textContent = String(state.size);
            markGraphDirty(node.graph);
            changed();
        };
        plus.onclick = () => after(addPort(node, state.id));
        minus.onclick = () => after(removePort(node, state.id));
        const row = el('li', {}, el('span', { textContent: state.id }), count, plus, minus);
        row.dataset.group = state.id;
        list.append(row);
    }
    return [el('section', { className: 'fl-isec' },
        el('h3', { textContent: 'Ports' }), list)];
}

// One of the flow's own inputs or outputs, design 10a: IN or OUT, its name,
// its type, and a way to take it away.
function pseudoRow(canvas, n, kind, changed) {
    const name = el('input', { type: 'text', value: n._irName, className: 'fl-io-name' });
    name.setAttribute('aria-label', `${kind} name`);
    name.onchange = () => {
        n._irName = name.value.trim() || n._irName;
        n.title = n._irName;
        markGraphDirty(canvas.graph);
        changed();
    };
    const type = el('select', { className: 'fl-type' });
    for (const t of PORT_TYPES) type.append(el('option', { value: t, textContent: t }));
    type.value = n._irStructure?.value?.id ?? 'anything';
    type.onchange = () => {
        if (type.value === 'anything') delete n._irStructure;
        else n._irStructure = { structure: 'droplet', value: { id: type.value, data: '' } };
        markGraphDirty(canvas.graph);
        changed();
    };
    // FND.14: the two a World block reaches the world through stay while one
    // is there to reach it.
    const locked = kind === 'input' && WORLD_INPUTS.includes(n._irName)
        && usesWorld(canvas.graph);
    const del = el('button', { type: 'button', className: 'fl-x', textContent: '\u00d7',
        disabled: locked, title: locked ? 'used by World blocks' : 'Remove' });
    del.setAttribute('aria-label', 'Remove');
    del.onclick = () => {
        canvas.graph.remove(n);
        markGraphDirty(canvas.graph);
        changed();
    };
    const row = el('li', {}, el('b', { textContent: kind === 'input' ? 'In' : 'Out' }),
        name, type, del, locked
            ? el('span', { className: 'muted fl-held', textContent: 'used by World blocks' })
            : '');
    row.dataset.port = n._irName;
    return row;
}

// The flow's own inputs and outputs, always at the foot of the inspector.
function drawIO(io, canvas, changed) {
    const lists = ['input', 'output'].map((kind) => {
        const list = el('ul', { className: `fl-ports fl-${kind}s` });
        for (const n of (canvas.graph._nodes ?? []).filter((x) => x._irKind === `pseudo-${kind}`)) {
            list.append(pseudoRow(canvas, n, kind, changed));
        }
        return list;
    });
    const adds = ['input', 'output'].map((kind) => {
        const add = el('button', { type: 'button', className: `fl-add-${kind} fl-link`,
            textContent: kind === 'input' ? 'Add in' : 'Add out' });
        add.setAttribute('aria-label', `Add ${kind}`);
        add.onclick = () => { canvas.addPseudo(kind); changed(); };
        return add;
    });
    io.replaceChildren(el('div', { className: 'fl-io-head' },
        el('h3', { textContent: 'Flow inputs and outputs' }), ...adds), ...lists);
}

// A block's name, which has to be unique in its scope: that is how the nets
// reach it, so a clash is refused in a sentence rather than renamed quietly.
function nameField(node, canvas, err, on) {
    const name = el('input', { type: 'text', value: node._irName ?? node.title,
        className: 'fl-name' });
    name.onchange = () => {
        const wanted = name.value.trim();
        const clash = (canvas.graph._nodes ?? [])
            .some((n) => n !== node && n._irName === wanted);
        if (!wanted || clash) {
            err.textContent = `${wanted} is already used in this flow`;
            err.hidden = false;
            name.value = node._irName;
            return;
        }
        err.hidden = true;
        node._irName = wanted;
        node.title = wanted;
        markGraphDirty(canvas.graph);
        on.changed();
    };
    return name;
}

// What Validate found, listed under the inspector. `goTo` takes the player to
// the block a problem names; a problem about the flow as a whole names none.
function drawProblems(found, list, goTo) {
    found.replaceChildren(el('h3', { textContent: 'Check' }));
    found.hidden = false;
    if (!list.length) {
        found.append(el('p', { className: 'muted',
            textContent: 'Nothing wrong that this page can see.' }));
        return;
    }
    const rows = el('ul', { className: 'fl-problem-list' });
    for (const p of list) {
        const li = el('li', {});
        li.dataset.block = p.block ?? '';
        const b = el('button', { type: 'button',
            textContent: p.where ? `${p.where} \u203a ${p.words}` : p.words });
        b.onclick = () => p.block && goTo?.(p.block);
        li.append(b);
        rows.append(li);
    }
    found.append(rows);
}

export function mountInspector(host, canvas, on) {
    const id = el('span', { className: 'fl-iid' });
    const head = el('div', { className: 'fl-ihead' },
        el('h2', { textContent: 'Inspector' }), id);
    const body = el('div', { className: 'fl-inspect' });
    const io = el('div', { className: 'fl-io' });
    // What Validate found, under the inspector rather than inside it: it is
    // about the flow, and it stays there while blocks are selected and
    // deselected (FND.2).
    const found = el('div', { className: 'fl-problems' });
    found.hidden = true;
    host.append(head, body, found, io);

    function drawBlock(node) {
        const err = el('p', { className: 'fl-err', hidden: true });
        const name = nameField(node, canvas, err, on);
        const what = `${node._irPlugin ?? '?'}/${node._irNodeId ?? '?'}`;
        id.textContent = what;
        body.replaceChildren(...[
            el('section', { className: 'fl-isec fl-iname' },
                el('h3', { textContent: 'Name' }), name, err),
            // Invariant: what this world cannot draw, it still keeps. A block
            // whose plugin is not in the palette is hatched on the canvas and
            // says so here, and is saved back exactly as it arrived.
            node._irPlaceholder
                ? el('p', { className: 'fl-unknown',
                    textContent: `unknown block ${what} \u2014 kept exactly as it came` })
                : null,
            // FL.2 (flowblocks.js): known here, but not to the chosen server.
            node._irMissingOn
                ? el('p', { className: 'fl-unknown fl-missing', textContent: node._irMissingOn })
                : null,
            ...parameters(node, on.changed),
            ...(isWorldBlock(node) ? worldFields(node, on.world, on.changed) : []),
            ...constants(node, on.changed, isWorldBlock(node) ? WORLD_PORTS : new Set()),
            ...portGroups(node, on.changed)].filter(Boolean));
    }

    function drawFlow() {
        const nets = canvas.nets();
        const netList = el('ul', { className: 'fl-nets' });
        for (const n of nets) {
            const b = el('button', { type: 'button',
                textContent: n.mode === 'wires' ? 'as labels' : 'as wires' });
            b.onclick = () => { canvas.toggleNet(n.name); on.changed(); };
            const li = el('li', {}, el('span', { textContent: n.name }), b);
            li.dataset.net = n.name;
            netList.append(li);
        }
        id.textContent = 'flow';
        body.replaceChildren(
            el('p', { className: 'muted fl-inone',
                textContent: 'Nothing selected. Choose a block to set it; below is what'
                    + ' the flow takes in and gives back.' }),
            ...(nets.length ? [el('section', { className: 'fl-isec' },
                el('h3', { textContent: 'Named nets' }), netList)] : []));
    }

    return {
        node: host,
        show(node) {
            if (node && node._irKind === 'node') drawBlock(node); else drawFlow();
            drawIO(io, canvas, on.changed);
        },
        problems: (list, goTo) => drawProblems(found, list, goTo),
    };
}
