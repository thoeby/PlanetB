// LV.14: no tab code reads a stored file by the /tiles path it was PUT at.
// The one place the path is spelt is client/js/peerfetch.js, whose reads go by
// CID; the others below name it for something else, and say what.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ALLOWED = new Map([
    ['js/peerfetch.js', 'the path, spelt once; reads go by CID'],
    ['js/covermap.js', 'a picture the server draws, not a stored file'],
    ['atoms/sog.js', 'where a tile is PUT, which is unchanged'],
]);

function* sources(dir) {
    for (const name of readdirSync(dir)) {
        const at = join(dir, name);
        if (statSync(at).isDirectory()) {
            if (!['vendor', 'test'].includes(name)) yield* sources(at);
        } else if (name.endsWith('.js')) yield at;
    }
}

test('only peerfetch.js spells the /tiles path a tab reads', () => {
    const found = [];
    for (const dir of ['js', 'atoms', 'lib', 'flow']) {
        for (const file of sources(join(ROOT, dir))) {
            const rel = relative(ROOT, file);
            const code = readFileSync(file, 'utf8').split('\n')
                .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
            if (/\/tiles\//.test(code) && !ALLOWED.has(rel)) found.push(rel);
        }
    }
    assert.deepEqual(found, []);
});
