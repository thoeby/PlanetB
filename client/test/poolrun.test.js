// The press of Render follows the tile, not the job number (db/0201): a job
// replaced under the tab is gone on with, once.

import test from 'node:test';
import assert from 'node:assert/strict';

import { replacement } from '../js/poolrun.js';

const row = (over = {}) => ({ job: 1, z: 14, x: 8548, y: 5800, ready: 1, ...over });

test('a tile whose job was replaced is followed to the new job', () => {
    const pressed = row({ job: 1 });
    const next = replacement(pressed, [row({ job: 2 })], new Set([1]));
    assert.equal(next?.job, 2);
});

test('the same job, another tile, or a job with nothing ready is not', () => {
    const pressed = row({ job: 1 });
    assert.equal(replacement(pressed, [row({ job: 1 })], new Set([1])), null);
    assert.equal(replacement(pressed, [row({ job: 2, x: 8549 })], new Set([1])), null);
    assert.equal(replacement(pressed, [row({ job: 2, ready: 0 })], new Set([1])), null);
    assert.equal(replacement(pressed, [], new Set([1])), null);
});

test('a job already followed is not followed again', () => {
    const pressed = row({ job: 2 });
    assert.equal(replacement(pressed, [row({ job: 1 })], new Set([1, 2])), null);
});
