#!/usr/bin/env node
// The `motion` and `interact` plugins (TASKS-live.md LV.3), written out as the
// static files the palette reads: a plugin.xml per plugin and one composite
// ELX per block, under client/flow/{motion,interact}/.
//
// Every block is a composite over what the palette already has: a motion is a
// JSON object put together with `json` blocks and written with `world`'s Write
// Port; an interaction is the same request `world`'s own composites make, to
// the RPC that says it (db/0204). Nothing here runs anything. Generated so the
// eleven files cannot drift from each other; the files are what is committed.
//
//   node tools/make-flow-plugins.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FLOW = join(dirname(fileURLToPath(import.meta.url)), '../client/flow');

// ------------------------------------------------------------- plugin.xml

const input = (name, type, dflt) => dflt === undefined
    ? `            <input name="${name}">\n                <structure id="droplet"/>\n`
      + `                <value id="${type}"/>\n            </input>`
    : `            <input name="${name}">\n`
      + '                <structure id="droplet" default="true">\n'
      + `                    <value id="${type}">${dflt}</value>\n                </structure>\n`
      + `                <value id="${type}"/>\n            </input>`;
const output = (name, type) =>
    `            <output name="${name}">\n                <structure id="droplet"/>\n`
    + `                <value id="${type}"/>\n            </output>`;

const WORLD_IN = [['World', 'url'], ['World Key', 'string'], ['Object', 'string']];

function nodeXml(b) {
    return [`        <node id="${b.id}">`, `            <name>${b.name}</name>`,
        `            <description type="short">${b.short}</description>`,
        `            <description type="long">${b.long}</description>`,
        ...b.inputs.map(([n, t, d]) => input(n, t, d)),
        ...b.outputs.map(([n, t]) => output(n, t)), '        </node>'].join('\n');
}

function pluginXml(id, name, groups) {
    return [`<plugin format="1" id="${id}">`, `    <name>${name}</name>`,
        '    <icon type="simicons">file::http</icon>', '',
        ...groups.flatMap((g) => [`    <group id="${g.id}">`, `        <name>${g.name}</name>`,
            '', g.blocks.map(nodeXml).join('\n\n'), '    </group>', '']),
        '</plugin>', ''].join('\n');
}

// ------------------------------------------------------------ composites

// A composite, from its inputs, outputs, nets as [from, to] pairs of
// "Node" or "Node.port", and its nodes as [name, plugin, id, params].
function elx({ inputs, outputs, nets, nodes }) {
    const conn = (s) => {
        const [node, ...port] = s.split('.');
        return port.length ? `<connection node="${node}" port="${port.join('.')}"/>`
            : `<connection node="${node}"/>`;
    };
    const lines = ['<elx>', '    <engine type="flow"/>',
        ...inputs.map((n) => `    <input name="${n}"/>`),
        ...outputs.map((n) => `    <output name="${n}"/>`),
        ...nets.map(([a, b], i) => `    <net name="N${String(i).padStart(3, '0')}">\n`
            + `        ${conn(a)}\n        ${conn(b)}\n    </net>`),
        ...nodes.map(([name, plugin, id, params = {}]) => {
            const ps = Object.entries(params);
            if (!ps.length) return `    <node id="${id}" name="${name}" plugin="${plugin}"/>`;
            return `    <node id="${id}" name="${name}" plugin="${plugin}">\n`
                + ps.map(([k, [t, v]]) => `        <parameter id="${k}"><value id="${t}">${v}`
                    + '</value></parameter>').join('\n') + '\n    </node>';
        }), '</elx>', ''];
    return lines.join('\n');
}

// A motion: `fields` are [input, key] into `to` (or into the value itself
// when `flat`), `over` whether it takes an Over, `fixed` a constant value.
function motion({ fields = [], flat = false, over = true, fixed = null }) {
    const ins = ['World', 'World Key', 'Object', 'Port', ...fields.map(([n]) => n),
        ...(over ? ['Over'] : []), 'When'];
    const nets = [];
    const nodes = [];
    let last = null;
    if (fixed) {
        nodes.push(['Motion', 'json', 'from-string', { string: ['string', fixed] }]);
        last = 'Motion.json';
    } else {
        nodes.push(['Empty', 'json', 'create-empty-object']);
        last = 'Empty.json';
        for (const [name, key] of fields) {
            nodes.push([`Set ${name}`, 'json', 'set', { key: ['string', key] }]);
            nets.push([last, `Set ${name}.json`], [name, `Set ${name}.value`]);
            last = `Set ${name}.out`;
        }
        if (!flat) {
            nodes.push(['Outer', 'json', 'create-empty-object'], ['With To', 'json', 'set',
                { key: ['string', 'to'] }]);
            nets.push(['Outer.json', 'With To.json'], [last, 'With To.value']);
            last = 'With To.out';
        }
        if (over) {
            nodes.push(['With Over', 'json', 'set', { key: ['string', 'over_s'] }]);
            nets.push([last, 'With Over.json'], ['Over', 'With Over.value']);
            last = 'With Over.out';
        }
    }
    nodes.push(['Body', 'json', 'to-string'], ['Gate', 'builtin', 'flow-control.if-else'],
        ['Write', 'world', 'port.write']);
    nets.push([last, 'Body.json'], ['Body.string', 'Gate.in'], ['When', 'Gate.condition'],
        ['Gate.true', 'Write.Value'], ['World', 'Write.World'],
        ['World Key', 'Write.World Key'], ['Object', 'Write.Object'], ['Port', 'Write.Port'],
        ['Write.OK', 'OK'], ['Write.Error', 'Error']);
    return elx({ inputs: ins, outputs: ['OK', 'Error'], nets, nodes });
}

// An interaction: one request to one RPC, with the body made of `fields`
// ([input, key]); `answers` are [output, pointer] read off the reply.
function request({ rpc, fields, answers = [], when = true }) {
    const ins = ['World', 'World Key', ...fields.map(([n]) => n), ...(when ? ['When'] : [])];
    const nodes = [['Where', 'strings', 'append', { append: ['string', `/rpc/${rpc}`] }],
        ['Bearer', 'strings', 'prepend', { prepend: ['string', 'Bearer '] }],
        ['Headers', 'builtin', 'structures.map.insert-or-assign',
            { key: ['string', 'Authorization'] }],
        ['Empty', 'json', 'create-empty-object']];
    const nets = [['World', 'Where.in'], ['Where.out', 'Request.Request URL'],
        ['World Key', 'Bearer.in'], ['Bearer.out', 'Headers.value'],
        ['Headers.out', 'Request.Request Headers']];
    let last = 'Empty.json';
    for (const [name, key] of fields) {
        nodes.push([`With ${name}`, 'json', 'set', { key: ['string', key] }]);
        nets.push([last, `With ${name}.json`], [name, `With ${name}.value`]);
        last = `With ${name}.out`;
    }
    nodes.push(['Body', 'json', 'to-string']);
    nets.push([last, 'Body.json']);
    if (when) {
        nodes.push(['Gate', 'builtin', 'flow-control.if-else']);
        nets.push(['Body.string', 'Gate.in'], ['When', 'Gate.condition'],
            ['Gate.true', 'Request.Request Body']);
    } else {
        nets.push(['Body.string', 'Request.Request Body']);
    }
    nodes.push(['Request', 'http', 'client.make-request-simple',
        { 'Request Method': ['string', 'POST'] }]);
    const outs = [];
    if (answers.length) {
        nodes.push(['Said', 'json', 'from-string']);
        nets.push(['Request.Response Body', 'Said.string']);
        // A node may not share a name with an output, so each answer is read
        // into a node of its own called "Read …".
        for (const [out, pointer] of answers) {
            nodes.push([`Read ${out}`, 'json', 'get', { pointer: ['string', pointer] }]);
            nets.push(['Said.json', `Read ${out}.json`], [`Read ${out}.out`, out]);
            outs.push(out);
        }
    } else {
        nodes.push(['Took It', 'mathematics', 'arithmetic.comparison.less',
            { 'in 2': ['integer', '300'] }]);
        nets.push(['Request.Response Status', 'Took It.in 1'], ['Took It.out', 'OK']);
        outs.push('OK');
    }
    nets.push(['Request.Error', 'Error']);
    return elx({ inputs: ins, outputs: [...outs, 'Error'], nets, nodes });
}

// -------------------------------------------------------------- the blocks

const OUT_OK = [['OK', 'boolean'], ['Error', 'error-code']];
const WHEN = ['When', 'boolean', 'true'];
const OVER = ['Over', 'real', '1.0'];
const PORT_IN = ['Port', 'string'];

const MOTION = [
    { id: 'move-to', name: 'Move To', short: 'Move a part to a place, taking so long',
        long: 'Tells a joint (LV.1) to go to x, y, z metres from where the maker left'
            + ' it, over so many seconds. Every tab moves it from where it is, by the'
            + ' world clock.',
        fields: [['X', 'x'], ['Y', 'y'], ['Z', 'z']], types: 'real' },
    { id: 'turn-to', name: 'Turn To', short: 'Turn a part to an angle, taking so long',
        long: 'Tells a joint to turn to yaw, pitch and roll, in degrees, over so many seconds.',
        fields: [['Yaw', 'yaw'], ['Pitch', 'pitch'], ['Roll', 'roll']], types: 'real' },
    { id: 'scale-to', name: 'Scale To', short: 'Make a part bigger or smaller',
        long: 'Tells a joint to take on a scale, over so many seconds. 1 is the size it was made.',
        fields: [['Scale', 'scale']], types: 'real', defaults: { Scale: '1.0' } },
    { id: 'follow-path', name: 'Follow Path', short: 'Send a part along a line of points',
        long: 'Tells a joint to follow a line of [x, y, z] points in metres, at so '
            + 'many metres a second, once or round and round.',
        fields: [['Route', 'route_m'], ['Speed', 'speed'], ['Loop', 'loop']], flat: true,
        over: false, typed: { Route: 'json', Speed: 'real', Loop: 'boolean' },
        defaults: { Speed: '1.0', Loop: 'false' } },
    { id: 'spin', name: 'Spin', short: 'Turn a part round and round',
        long: 'Tells a joint to turn about x, y or z at so many turns a minute, for '
            + 'as long as nobody says otherwise.',
        fields: [['Axis', 'axis'], ['RPM', 'rpm']], flat: true, over: false,
        typed: { Axis: 'string', RPM: 'real' }, defaults: { Axis: 'y', RPM: '6.0' } },
    { id: 'stop', name: 'Stop', short: 'Stop a part where it is',
        long: 'Tells a joint to stay exactly where it is now, whatever it was doing.',
        fields: [], over: false, fixed: '{"to":{},"over_s":0}' },
];

function motionBlock(b) {
    const typeOf = (n) => b.typed?.[n] ?? b.types ?? 'real';
    const inputs = [...WORLD_IN, PORT_IN,
        ...b.fields.map(([n]) => [n, typeOf(n), b.defaults?.[n] ?? (b.types ? '0.0' : undefined)]),
        ...(b.over === false ? [] : [OVER]), WHEN];
    return { ...b, inputs, outputs: OUT_OK,
        composite: motion({ fields: b.fields, flat: b.flat, over: b.over !== false,
            fixed: b.fixed }) };
}

const INTERACT = [
    { group: 'trigger', id: 'on', name: 'On Trigger',
        short: 'Whether a thing was set off, and how, since an event',
        long: 'Asks the world whether this thing was set off by the given kind — '
            + 'click, near, far, key, use (LV.2) — after the event whose number is '
            + 'given. Fired is true when it was.',
        inputs: [...WORLD_IN, ['Kind', 'string', 'near'], ['After', 'integer', '0']],
        outputs: [['Fired', 'boolean'], ['Events', 'json'], ['Last ID', 'integer'],
            ['Error', 'error-code']],
        composite: request({ rpc: 'triggers_since', when: false,
            fields: [['Object', 'p_instance'], ['Kind', 'p_kind'], ['After', 'p_after']],
            answers: [['Fired', 'fired'], ['Events', 'events'], ['Last ID', 'last_id']] }) },
    { group: 'hold', id: 'give', name: 'Give',
        short: 'Hand a thing to somebody, or put it in something',
        long: 'Gives a thing that may be carried (LV.4) to a player, or puts it into '
            + 'a container, by id. Refused in words when it is not the giver\'s to '
            + 'give.',
        inputs: [...WORLD_IN, ['To', 'string'], WHEN], outputs: OUT_OK,
        composite: request({ rpc: 'give', fields: [['Object', 'p_instance'], ['To', 'p_to']] }) },
    { group: 'hold', id: 'take', name: 'Take', short: 'Take a thing into the land owner\'s hands',
        long: 'Takes a thing that may be carried (LV.4). Refused in words when '
            + 'somebody else already has it.',
        inputs: [...WORLD_IN, WHEN], outputs: OUT_OK,
        composite: request({ rpc: 'take', fields: [['Object', 'p_instance']] }) },
    { group: 'say', id: 'post', name: 'Post', short: 'Say something over a thing',
        long: 'Puts a line of words over a thing, for everybody standing near it to read.',
        inputs: [...WORLD_IN, ['Text', 'string'], WHEN], outputs: OUT_OK,
        composite: request({ rpc: 'post_note',
            fields: [['Object', 'p_instance'], ['Text', 'p_text']] }) },
];

const GROUP_NAMES = { part: 'Part', trigger: 'Trigger', hold: 'Hold', say: 'Say' };

// Every file of both plugins, path under client/flow -> text.
export function files() {
    const out = {};
    const put = (plugin, name, groups) => {
        out[`${plugin}/plugin.xml`] = pluginXml(plugin, name, groups);
        for (const g of groups) {
            for (const b of g.blocks) {
                out[`${plugin}/assets/nodes/${g.id}__${b.id}.xml`] = b.composite;
            }
        }
    };
    put('motion', 'Motion',
        [{ id: 'part', name: GROUP_NAMES.part, blocks: MOTION.map(motionBlock) }]);
    put('interact', 'Interact', [...new Set(INTERACT.map((b) => b.group))].map((id) =>
        ({ id, name: GROUP_NAMES[id], blocks: INTERACT.filter((b) => b.group === id) })));
    return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const all = files();
    for (const [path, text] of Object.entries(all)) {
        mkdirSync(dirname(join(FLOW, path)), { recursive: true });
        writeFileSync(join(FLOW, path), text);
    }
    console.log(`make-flow-plugins: ${Object.keys(all).length} files`);
}

export { MOTION, INTERACT };
