// marks.js — what a maker says about the nodes of their model.
//
// FND.6. A street lamp is not only a shape: its head lights up, a billboard's
// screen shows something, a tunnel portal's mouth opens the ground. None of
// that is in the GLB, because no two exporters agree on how to put it there.
// The maker says it in the Register form instead, and it travels in the
// register call as `asset.parts` (db/0138).
//
// Three markings:
//   parts     — a node that stays a mesh of its own under canon-v2, with a role
//   ports     — what a placed one can be told, and which part it drives
//   openings  — a node whose footprint opens the terrain (FND.11)
//
// Pure. The canonical *text* these are hashed into lives in SQL and nowhere
// else (db/0138), so the SAN has one definition and cannot drift; what is here
// is the shape, the vocabulary, and the refusals the form says before it
// uploads. The database says them again (Invariant 6).

// A name is typed by a person and then read by a machine: the node it points
// at, the port a symbol drives. Keeping it to one word of plain characters is
// what lets the canonical text be written without escaping anything.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export const ROLES = [
    { id: 'light', words: 'Lights up', ports: ['on', 'colour', 'brightness'] },
    { id: 'screen', words: 'Shows something', ports: ['image'] },
    { id: 'door', words: 'Opens', ports: ['open'] },
    { id: 'rotor', words: 'Turns', ports: ['speed'] },
];

export const PORT_TYPES = ['boolean', 'number', 'text', 'image', 'colour'];

// The ports a role offers, with what each one drives and what it is when
// nobody has said otherwise.
export const PORTS = {
    on: { type: 'boolean', default: 'false', what: 'light' },
    colour: { type: 'colour', default: '#ffd9a0', what: 'colour' },
    brightness: { type: 'number', default: '1.000', what: 'intensity' },
    image: { type: 'image', default: '', what: 'texture' },
    open: { type: 'number', default: '0.000', what: 'pose' },
    speed: { type: 'number', default: '0.000', what: 'rate' },
};

export const roleWords = (role) => ROLES.find((r) => r.id === role)?.words ?? role;

const num = (v, fallback = 0) => {
    const n = Number(v);
    return (Number.isFinite(n) ? n : fallback).toFixed(3);
};

// ------------------------------------------------------------- canonical form

// The same markings typed in two orders are one product, so everything is
// sorted by name and every number is written the one way. The text this is
// hashed into is db/0138's; this is the shape that text is read from.
export function canonMarks(from = {}) {
    const marks = from ?? {};
    const parts = (marks.parts ?? []).map((p) => ({
        name: String(p.name ?? ''),
        node: String(p.node ?? ''),
        role: String(p.role ?? ''),
        colour: p.role === 'light' ? String(p.colour ?? PORTS.colour.default) : undefined,
        intensity: p.role === 'light' ? num(p.intensity, 1) : undefined,
        aspect: p.role === 'screen' ? num(p.aspect, 1.778) : undefined,
        axis: p.role === 'door' || p.role === 'rotor' ? String(p.axis ?? 'y') : undefined,
        range: p.role === 'door' || p.role === 'rotor' ? num(p.range, 90) : undefined,
    })).map((p) => JSON.parse(JSON.stringify(p)))
        .sort((a, b) => a.name.localeCompare(b.name));
    const ports = (marks.ports ?? []).map((p) => ({
        name: String(p.name ?? ''),
        type: String(p.type ?? PORTS[p.name]?.type ?? 'boolean'),
        default: p.default === undefined || p.default === null
            ? String(PORTS[p.name]?.default ?? '') : String(p.default),
        drives: { part: String(p.drives?.part ?? ''),
            what: String(p.drives?.what ?? PORTS[p.name]?.what ?? '') },
    })).sort((a, b) => a.name.localeCompare(b.name));
    const openings = (marks.openings ?? []).map((o) => ({
        name: String(o.name ?? ''), node: String(o.node ?? ''),
    })).sort((a, b) => a.name.localeCompare(b.name));
    return { parts, ports, openings };
}

export const isMarked = (marks) => Boolean(marks
    && ((marks.parts?.length ?? 0) || (marks.openings?.length ?? 0)));

// The nodes that are not the model's body any more: node name -> part name.
export const partNodes = (marks) =>
    new Map((marks?.parts ?? []).map((p) => [p.node, p.name]));

// What a placed one can be told, in the words the card uses (FND.6).
export function portWords(marks) {
    const ports = canonMarks(marks).ports;
    if (!ports.length) return '';
    return ports.map((p) => (p.type === 'boolean' ? `${p.name} (on/off)` : p.name))
        .join(', ');
}

// --------------------------------------------------------------- the refusals

// `nodes` is the GLB's node names, so a marking that points at nothing is
// caught here rather than by a mesh that comes out empty. db/0138 checks the
// vocabulary again without them (Invariant 6).
export function marksTrouble(marks, nodes = null) {
    const m = canonMarks(marks);
    const names = new Set();
    for (const p of m.parts) {
        if (!TOKEN.test(p.name)) return `"${p.name}" is not a name a part may have`;
        if (names.has(p.name)) return `there are two parts called ${p.name}`;
        names.add(p.name);
        if (!ROLES.some((r) => r.id === p.role)) return `${p.name} needs a role`;
        if (nodes && !nodes.includes(p.node)) {
            return `this model has no node called ${p.node}`;
        }
    }
    for (const o of m.openings) {
        if (!TOKEN.test(o.name)) return `"${o.name}" is not a name an opening may have`;
        if (nodes && !nodes.includes(o.node)) {
            return `this model has no node called ${o.node}`;
        }
    }
    return portTrouble(m, names);
}

function portTrouble(m, partNames) {
    const seen = new Set();
    for (const p of m.ports) {
        if (!TOKEN.test(p.name)) return `"${p.name}" is not a name a port may have`;
        if (seen.has(p.name)) return `there are two ports called ${p.name}`;
        seen.add(p.name);
        if (!PORT_TYPES.includes(p.type)) return `${p.name} is not a kind of port`;
        if (!partNames.has(p.drives.part)) {
            return `${p.name} drives ${p.drives.part || 'nothing'}, which is not a part`;
        }
        if (p.default !== '' && !TOKEN.test(p.default) && !/^#[0-9a-fA-F]{6}$/.test(p.default)
            && !/^-?[0-9.]+$/.test(p.default)) {
            return `${p.name} cannot start out as "${p.default}"`;
        }
    }
    return null;
}
