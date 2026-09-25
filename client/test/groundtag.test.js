// EDT.4 — the words at the pointer: the numbers box's rows and the two-word
// tag, most important state first.
import test from 'node:test';
import assert from 'node:assert/strict';

import { numbersRows, tagFor } from '../js/groundtag.js';

test('the numbers box: ground, this stroke, off the elevation, slope, limit', () => {
    const rows = numbersRows({ ground: 652.44, stroke: 1.2, off: 2, slope: 13.6,
        limit: { up: 8, down: 8 } });
    assert.deepEqual(rows.map((r) => r[0]),
        ['ground', 'this stroke', 'off the elevation', 'slope', 'limit']);
    assert.equal(rows[0][1], '652.4 m');
    assert.equal(rows[1][1], '+1.20 m');
    assert.equal(rows[3][1], '14°');
    assert.equal(numbersRows({ ground: 600, off: -0.5 })[1][1], '−0.50 m');
    assert.equal(numbersRows({ ground: 600, off: 0 })[1][1], '±0.00 m');
    // Over the limit, the numbers that are over it turn amber.
    const over = numbersRows({ ground: 600, off: 9, over: true, limit: { up: 8, down: 8 } });
    assert.equal(over.find((r) => r[0] === 'limit')[2], 'warn');
    assert.deepEqual(numbersRows({ lost: true }), [['ground', 'no ground', 'bad']]);
});

test('the tag says the one state that matters most', () => {
    assert.equal(tagFor({ lost: true }).text, 'no ground');
    assert.equal(tagFor({ inside: false }).text, 'not your land');
    assert.equal(tagFor({ inside: false, snapped: 'road end' }).text, 'snapped: road end');
    assert.equal(tagFor({ inside: true, over: true }).text, 'over limit');
    assert.equal(tagFor({ inside: true, band: true }).text, 'edge blend');
    assert.equal(tagFor({ inside: true }).text, '');
    assert.equal(tagFor({ inside: false }).tone, 'bad');
});
