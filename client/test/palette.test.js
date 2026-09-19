// The bundled block set is a directory of files and a list of them, and a
// browser cannot read a directory. tools/palette.sh writes the list; this says
// it is the list of what is actually there, so a plugin added without running
// the script is caught here rather than by a palette that is quietly short.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../flow/palette/', import.meta.url).pathname;

const manifest = () => JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

// The world's own blocks (FND.14) are in the bundled set but not in plugins/:
// they are not the reference editor's, and they live whole in
// client/flow/world so that directory can be copied into a process server's
// plugin folder as it is.
const OURS = ['world'];

test('the manifest lists every plugin that is there, and nothing that is not', () => {
    const onDisk = readdirSync(join(ROOT, 'plugins'))
        .filter((d) => existsSync(join(ROOT, 'plugins', d, 'plugin.xml'))).sort();
    const listed = manifest().plugins.map((p) => p.id).sort();
    assert.deepEqual(listed, [...onDisk, ...OURS].sort(), 'run `bash tools/palette.sh`');
    assert.ok(onDisk.length >= 20, 'the seed set is the reference editor\'s twenty-two');
});

test('every listed file is where the manifest says it is', () => {
    for (const p of manifest().plugins) {
        assert.ok(existsSync(join(ROOT, p.xml)), `${p.xml} is missing`);
        for (const a of p.assets ?? []) {
            assert.ok(existsSync(join(ROOT, 'plugins', p.id, a)), `${p.id}/${a} is missing`);
        }
    }
});

test('opencv is in the palette without its trained model', () => {
    const ids = manifest().plugins.map((p) => p.id);
    assert.ok(ids.includes('opencv'), 'the blocks are there');
    const assets = join(ROOT, 'plugins/opencv/assets');
    assert.ok(!existsSync(assets), '5.2 MB of face-detection weights are not');
});

test('nothing in the palette is big enough to be a model', () => {
    const big = [];
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (statSync(p).size > 200_000) big.push(p.slice(ROOT.length));
        }
    };
    walk(ROOT);
    assert.deepEqual(big, [], 'the palette is XML, not assets');
});
