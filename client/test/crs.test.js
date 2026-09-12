// client/lib/crs.js is the only place under client/js and client/lib that
// spells a coordinate system out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TILE, WORLD, WORLD_SRID } from '../lib/crs.js';

const HERE = new URL('.', import.meta.url).pathname;
const STRAY = /EPSG:\d|\b(?:4326|3857)\b/;

test('the two systems are what the database stores and tiles', () => {
    assert.equal(WORLD, `EPSG:${WORLD_SRID}`);
    assert.equal(TILE, 'EPSG:3857');
});

test('no EPSG code outside lib/crs.js', () => {
    for (const dir of ['js', 'lib']) {
        for (const name of readdirSync(join(HERE, '..', dir))) {
            if (!name.endsWith('.js') || name === 'crs.js') continue;
            const lines = readFileSync(join(HERE, '..', dir, name), 'utf8').split('\n');
            lines.forEach((line, i) => {
                assert.doesNotMatch(line, STRAY, `${dir}/${name}:${i + 1}: ${line.trim()}`);
            });
        }
    }
});
