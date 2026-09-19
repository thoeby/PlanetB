// FND.14 — the world as blocks a flow can be drawn with.
//
// The plugin and its composites are static files (client/flow/world/). This
// reads them the way the palette does and holds them to what the editor and
// the process server both need: the five blocks, their ports, and composites
// that name only blocks the bundled palette already has.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// client/flow/plugins/parse.js is the editor's own reader and wants a
// DOMParser, which node has not got; the browser suite is where it runs
// (client/test/e2e/flow). This reads the same files as text, which is what
// they are: what is asserted here is the shape a process server and the
// palette both need, not how the editor parses it.
const HERE = new URL('..', import.meta.url).pathname;
const WORLD = join(HERE, 'flow/world');
const PALETTE = join(HERE, 'flow/palette');

const xml = readFileSync(join(WORLD, 'plugin.xml'), 'utf8');

// Every block of a plugin file, as `group.node` with its ports.
function blocksIn(text) {
    const out = new Map();
    const path = [];
    for (const line of text.split('\n')) {
        const g = /<group id="([^"]+)"/.exec(line);
        if (g) { path.push(g[1]); continue; }
        if (/<\/group>/.test(line)) { path.pop(); continue; }
        const n = /<node id="([^"]+)"/.exec(line);
        if (n) out.set([...path, n[1]].join('.'), { inputs: [], outputs: [] });
        const io = /<(input|output) name="([^"]+)"/.exec(line);
        if (io && out.size) {
            const last = [...out.values()].at(-1);
            last[io[1] === 'input' ? 'inputs' : 'outputs'].push({ name: io[2] });
        }
    }
    return out;
}

const plugin = { id: /<plugin[^>]*id="([^"]+)"/.exec(xml)[1] };
const blocks = () => blocksIn(xml);

test('the world is a plugin with five blocks in four groups', () => {
    assert.equal(plugin.id, 'world');
    const found = blocks();
    assert.deepEqual([...found.keys()].sort(),
        ['clock.now', 'events.since', 'mover.set', 'port.read', 'port.write']);
});

test('writing a port takes what it needs and says whether it took', () => {
    const write = blocks().get('port.write');
    assert.deepEqual(write.inputs.map((i) => i.name),
        ['World', 'World Key', 'Object', 'Port', 'Value']);
    assert.deepEqual(write.outputs.map((o) => o.name), ['OK', 'Error']);
});

test('every block says where the world is and who it is', () => {
    for (const [id, node] of blocks()) {
        const names = node.inputs.map((i) => i.name);
        assert.ok(names.includes('World'), `${id} takes the world's address`);
        if (id !== 'clock.now') {
            assert.ok(names.includes('World Key'), `${id} takes a key of its own`);
        }
        assert.ok(node.outputs.some((o) => o.name === 'Error'),
            `${id} says when it could not`);
    }
});

test('there is a composite for every block, and one block for every composite', () => {
    const files = readdirSync(join(WORLD, 'assets/nodes')).filter((f) => f.endsWith('.xml'));
    assert.deepEqual(files.sort(),
        ['clock__now.xml', 'events__since.xml', 'mover__set.xml',
            'port__read.xml', 'port__write.xml']);
    for (const id of blocks().keys()) {
        assert.ok(files.includes(`${id.replace('.', '__')}.xml`), `${id} has its ELX`);
    }
});

test('a composite is built only from blocks the palette already has', () => {
    const have = new Set();
    for (const dir of readdirSync(join(PALETTE, 'plugins'))) {
        const text = readFileSync(join(PALETTE, 'plugins', dir, 'plugin.xml'), 'utf8');
        for (const id of blocksIn(text).keys()) have.add(`${dir}.${id}`);
    }
    for (const file of readdirSync(join(WORLD, 'assets/nodes'))) {
        const xml = readFileSync(join(WORLD, 'assets/nodes', file), 'utf8');
        for (const m of xml.matchAll(/<node id="([^"]+)"[^>]*plugin="([^"]+)"/g)) {
            assert.ok(have.has(`${m[2]}.${m[1]}`),
                `${file} names ${m[2]}.${m[1]}, which the palette does not have`);
        }
    }
});

test('the palette offers the world alongside the rest', () => {
    const manifest = JSON.parse(readFileSync(join(PALETTE, 'manifest.json'), 'utf8'));
    assert.ok(manifest.plugins.some((p) => p.id === 'world'),
        'a block nobody can drag is a block nobody has');
});
