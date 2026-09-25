// LV.3 — `motion` and `interact`: composites over what the palette has.
//
// Every block of the two plugins has its ELX; every ELX names only blocks the
// bundled palette or the world plugin has, and only ports those blocks have;
// every net joins two ends that exist; and the generated files are what
// tools/make-flow-plugins.mjs writes today. `make flow-test` runs this.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { files } from '../../tools/make-flow-plugins.mjs';

const FLOW = new URL('../flow/', import.meta.url).pathname;

// Every block of a plugin file, as `group.node` with its port names.
function blocksIn(text) {
    const out = new Map();
    const path = [];
    let last = null;
    for (const line of text.split('\n')) {
        const g = /<group id="([^"]+)"/.exec(line);
        if (g) { path.push(g[1]); continue; }
        if (/<\/group>/.test(line)) { path.pop(); continue; }
        const n = /<node id="([^"]+)"/.exec(line);
        if (n) { last = { ports: new Set() }; out.set([...path, n[1]].join('.'), last); }
        const io = /<(input|output) name="([^"]+)"/.exec(line);
        if (io && last) last.ports.add(io[2]);
    }
    return out;
}

// What the palette offers: plugin -> block id -> ports.
function palette() {
    const have = new Map();
    const dirs = readdirSync(join(FLOW, 'palette/plugins'))
        .map((d) => [d, join(FLOW, 'palette/plugins', d, 'plugin.xml')]);
    for (const [id, file] of [...dirs, ['world', join(FLOW, 'world/plugin.xml')]]) {
        try { have.set(id, blocksIn(readFileSync(file, 'utf8'))); } catch { /* no plugin.xml */ }
    }
    return have;
}

for (const plugin of ['motion', 'interact']) {
    test(`every ${plugin} block is a composite of blocks and ports that exist`, () => {
        const have = palette();
        const own = blocksIn(readFileSync(join(FLOW, plugin, 'plugin.xml'), 'utf8'));
        const files = readdirSync(join(FLOW, plugin, 'assets/nodes'));
        assert.deepEqual(files.sort(), [...own.keys()].map((id) =>
            `${id.replace('.', '__')}.xml`).sort(), 'one ELX a block, one block an ELX');
        for (const [id, block] of own) {
            const xml = readFileSync(join(FLOW, plugin, 'assets/nodes',
                `${id.replace('.', '__')}.xml`), 'utf8');
            const ends = new Set([...xml.matchAll(/<(?:input|output) name="([^"]+)"/g)]
                .map((m) => m[1]));
            assert.deepEqual(ends, block.ports, `${id}: the ELX has the block's ports`);
            const nodes = new Map();
            for (const m of xml.matchAll(/<node id="([^"]+)" name="([^"]+)" plugin="([^"]+)"/g)) {
                const known = have.get(m[3])?.get(m[1]);
                assert.ok(known, `${id} names ${m[3]}.${m[1]}, which the palette has not got`);
                assert.ok(!ends.has(m[2]), `${id}: node ${m[2]} shares a name with a port`);
                nodes.set(m[2], known);
            }
            for (const m of xml.matchAll(/<connection node="([^"]+)"(?: port="([^"]+)")?\/>/g)) {
                if (!m[2]) {
                    assert.ok(ends.has(m[1]), `${id}: ${m[1]} is no port of the block`);
                    continue;
                }
                assert.ok(nodes.get(m[1])?.ports.has(m[2]),
                    `${id}: ${m[1]} has no port ${m[2]}`);
            }
        }
    });
}

test('the files are what tools/make-flow-plugins.mjs writes', () => {
    for (const [path, text] of Object.entries(files())) {
        assert.equal(readFileSync(join(FLOW, path), 'utf8'), text,
            `${path} is stale: run node tools/make-flow-plugins.mjs`);
    }
    assert.match(files()['interact/assets/nodes/trigger__on.xml'], /\/rpc\/triggers_since/,
        'On Trigger asks the world for one kind on one thing');
});

test('the palette offers both', () => {
    const manifest = JSON.parse(readFileSync(join(FLOW, 'palette/manifest.json'), 'utf8'));
    for (const id of ['motion', 'interact']) {
        assert.ok(manifest.plugins.some((p) => p.id === id), `${id} is in the palette`);
    }
});
