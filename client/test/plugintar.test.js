// A plugin folder is one canonical file (LV.7, client/lib/plugintar.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { canonPlugin } from '../lib/plugintar.js';
import { writeTar } from '../lib/tar.js';

const MOTION = new URL('../flow/motion/', import.meta.url).pathname;

function folder(prefix = '') {
    const out = [{ name: `${prefix}plugin.xml`, bytes: readFileSync(join(MOTION, 'plugin.xml')) }];
    for (const f of readdirSync(join(MOTION, 'assets/nodes'))) {
        out.push({ name: `${prefix}assets/nodes/${f}`,
            bytes: readFileSync(join(MOTION, 'assets/nodes', f)) });
    }
    return out;
}

test('the same folder, packed in any order and under any name, is the same bytes', () => {
    const a = canonPlugin(writeTar(folder()));
    const b = canonPlugin(writeTar(folder('motion/').reverse()));
    assert.deepEqual(a.bytes, b.bytes);
    assert.equal(a.id, 'motion');
    assert.equal(a.blocks, 6);
    assert.deepEqual(a.files, [...a.files].sort());
});

test('a folder with no plugin.xml is not a plugin', () => {
    assert.throws(() => canonPlugin(writeTar([{ name: 'x.txt', bytes: new Uint8Array(1) }])),
        /no plugin.xml/);
});
