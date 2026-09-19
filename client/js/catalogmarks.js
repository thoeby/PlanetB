// catalogmarks.js — the Parts step of Register: which nodes of this model are
// live, what each one does, and what a placed one can be told.
//
// FND.6. The GLB's node tree is on the left; clicking a node shows it in the
// preview and offers a role. A node with a role stays a mesh of its own under
// canon-v2 (client/lib/canon.js) and can be given ports from the short list
// its role has; a node can also be marked as an opening, which is where the
// terrain gets a hole (FND.11).
//
// It decides nothing: what may be marked is client/lib/marks.js's, and what
// the world accepts is db/0160's (Invariant 6).

import { el } from './poolui.js';
import { PORTS, ROLES, canonMarks, portWords, roleWords } from '../lib/marks.js';

const NONE = 'part of the model';

// One row per node of the GLB, in the order canon-v2 would write them.
function nodeList(nodes, state, onPick) {
    const list = el('ul', { className: 'mk-nodes' });
    for (const node of nodes) {
        const part = state.parts.find((p) => p.node === node);
        const open = state.openings.find((o) => o.node === node);
        const button = el('button', { type: 'button', className: 'mk-node',
            textContent: node });
        button.classList.toggle('picked', state.at === node);
        button.addEventListener('click', () => onPick(node));
        list.append(el('li', {}, button, el('span', { className: 'muted mk-does',
            textContent: part ? roleWords(part.role) : open ? 'opens the ground' : '' })));
    }
    return list;
}

// What the node the maker is looking at may be told to do.
function roleForm(state, changed) {
    const role = el('select', { className: 'mk-role' });
    role.append(new Option(NONE, ''), ...ROLES.map((r) => new Option(r.words, r.id)));
    const part = state.parts.find((p) => p.node === state.at);
    role.value = part?.role ?? '';
    role.addEventListener('change', () => changed(() => setRole(state, role.value)));

    const opening = el('input', { type: 'checkbox', className: 'mk-opening',
        checked: state.openings.some((o) => o.node === state.at) });
    opening.addEventListener('change', () => changed(() => setOpening(state, opening.checked)));

    return el('div', { className: 'mk-role-form' },
        el('label', {}, 'This node ', role),
        el('label', {}, opening, ' opens the ground under it'));
}

function setRole(state, role) {
    state.parts = state.parts.filter((p) => p.node !== state.at);
    state.ports = state.ports.filter((p) => state.parts.some((q) => q.name === p.drives.part));
    if (!role) return;
    const name = state.at;
    state.parts.push({ name, node: state.at, role });
    state.parts.sort((a, b) => a.name.localeCompare(b.name));
}

function setOpening(state, wanted) {
    state.openings = state.openings.filter((o) => o.node !== state.at);
    if (wanted) state.openings.push({ name: state.at, node: state.at });
}

// The ports the role offers, each one a switch: add it, or do not.
function portForm(state, changed) {
    const part = state.parts.find((p) => p.node === state.at);
    if (!part) return null;
    const offered = ROLES.find((r) => r.id === part.role)?.ports ?? [];
    const rows = offered.map((name) => {
        const has = state.ports.some((p) => p.name === name && p.drives.part === part.name);
        const box = el('input', { type: 'checkbox', className: `mk-port mk-port-${name}`,
            checked: has });
        box.addEventListener('change',
            () => changed(() => setPort(state, part, name, box.checked)));
        return el('label', {}, box, ` ${name}`);
    });
    return el('div', { className: 'mk-ports' },
        el('span', { className: 'label', textContent: 'Can be told' }), ...rows);
}

function setPort(state, part, name, wanted) {
    state.ports = state.ports.filter((p) => !(p.name === name && p.drives.part === part.name));
    if (!wanted) return;
    const kind = PORTS[name];
    state.ports.push({ name, type: kind.type, default: kind.default,
        drives: { part: part.name, what: kind.what } });
    state.ports.sort((a, b) => a.name.localeCompare(b.name));
}

// The ports of the whole model, as a placed one would meet them: a switch for
// a boolean, a field for everything else. Flipping one redraws the preview —
// that is the whole point of a live part.
function liveForm(state, changed) {
    const rows = state.ports.map((port) => {
        const id = `mk-try-${port.name}`;
        if (port.type === 'boolean') {
            const box = el('input', { type: 'checkbox', className: `mk-try ${id}`,
                checked: state.values[port.name] === 'true' });
            box.addEventListener('change', () => changed(() => {
                state.values[port.name] = box.checked ? 'true' : 'false';
            }));
            return el('label', {}, box, ` ${port.name}`);
        }
        const field = el('input', { type: 'text', className: `mk-try ${id}`,
            value: state.values[port.name] ?? port.default });
        field.addEventListener('change', () => changed(() => {
            state.values[port.name] = field.value;
        }));
        return el('label', {}, `${port.name} `, field);
    });
    if (!rows.length) return null;
    return el('div', { className: 'mk-live' },
        el('span', { className: 'label', textContent: 'Try it' }), ...rows);
}

const sentence = (state) => {
    const marks = canonMarks(state);
    if (!marks.parts.length && !marks.openings.length) return 'no live parts';
    const parts = marks.parts.map((p) => `${p.name} ${roleWords(p.role).toLowerCase()}`);
    const opens = marks.openings.map((o) => `${o.name} opens the ground`);
    const ports = portWords(marks);
    return [...parts, ...opens].join(' · ') + (ports ? ` · ports: ${ports}` : '');
};

/**
 * The Parts step, mounted once and refilled whenever a file is picked.
 * `onChange` is told the markings and what the maker is looking at, so the
 * preview can be drawn again.
 */
export function mountMarksForm(host, { onChange } = {}) {
    const state = { nodes: [], at: null, parts: [], ports: [], openings: [], values: {} };
    const said = el('div', { className: 'muted mk-said' });
    const body = el('div', { className: 'mk-body' });
    host.replaceChildren(el('span', { className: 'label', textContent: 'Parts' }),
        el('div', { className: 'note', textContent:
            'A node with a role stays its own piece of the model and can be told'
            + ' things once it is placed. Everything else is flattened into one.' }),
        body, said);

    const paint = () => {
        said.textContent = sentence(state);
        body.replaceChildren(nodeList(state.nodes, state, (node) => {
            state.at = node;
            paint();
        }), ...(state.at ? [roleForm(state, changed), portForm(state, changed)] : [])
            .filter(Boolean), ...[liveForm(state, changed)].filter(Boolean));
        onChange?.(value(), state.at);
    };
    const changed = (apply) => { apply(); paint(); };
    const value = () => canonMarks(state);

    return {
        show(nodes) {
            Object.assign(state, { nodes: nodes ?? [], at: null, parts: [], ports: [],
                openings: [], values: {} });
            host.hidden = !state.nodes.length;
            paint();
        },
        value,
        values: () => ({ ...state.values }),
        at: () => state.at,
    };
}
