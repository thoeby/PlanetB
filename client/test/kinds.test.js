// EDT.13 — the kind picker's entries come from the vocabulary: one per kind
// and class for the geometry in hand, recent first, filtered by what is typed.
import test from 'node:test';
import assert from 'node:assert/strict';

import { entriesFor, entryOf, ordered, touched } from '../lib/kinds.js';

const KINDS = [
    { name: 'highway', applies_to: 'feature', geometry: 'line', label: 'Highway' },
    { name: 'barrier', applies_to: 'feature', geometry: 'line', label: 'Barrier' },
    { name: 'landuse', applies_to: 'feature', geometry: 'polygon', label: 'Landuse' },
    { name: 'product', applies_to: 'product', geometry: null, label: 'Product' },
];
const PROPS = [
    { kind: 'highway', name: 'highway', type: 'choice', choices: ['residential', 'track'] },
    { kind: 'highway', name: 'width', type: 'number', choices: [] },
    { kind: 'barrier', name: 'barrier', type: 'choice', choices: ['wall', 'hedge'] },
    { kind: 'landuse', name: 'landuse', type: 'choice', choices: ['forest'] },
];

test('one entry per kind and class, for lines only', () => {
    const e = entriesFor('line', KINDS, PROPS);
    assert.deepEqual(e.map((x) => x.id),
        ['highway:residential', 'highway:track', 'barrier:wall', 'barrier:hedge']);
    const road = e[0];
    assert.equal(road.words, 'highway · residential');
    assert.deepEqual(road.props, { highway: 'residential' });
    assert.equal(road.width, 5);
    assert.equal(road.corner, false);
    assert.equal(e.find((x) => x.id === 'barrier:wall').corner, true, 'walls are corners');
    assert.ok(e.find((x) => x.id === 'highway:track').width < road.width);
    assert.deepEqual(entriesFor('polygon', KINDS, PROPS).map((x) => x.id), ['landuse:forest']);
});

test('the operator’s defaults win, and a hidden kind is not offered', () => {
    const e = entriesFor('line', KINDS, PROPS, { highway: { width: 7, gradient: 9 },
        barrier: { hidden: true } });
    assert.deepEqual(e.map((x) => x.id), ['highway:residential', 'highway:track']);
    assert.equal(e[0].width, 7);
    assert.equal(e[0].gradient, 9);
});

test('recent on top, typed filters, nine at most remembered', () => {
    const e = entriesFor('line', KINDS, PROPS);
    assert.deepEqual(ordered(e, ['barrier:hedge']).map((x) => x.id)[0], 'barrier:hedge');
    assert.deepEqual(ordered(e, [], 'wal').map((x) => x.id), ['barrier:wall']);
    let r = [];
    for (let i = 0; i < 12; i++) r = touched(r, `k${i}`);
    assert.equal(r.length, 9);
    assert.equal(r[0], 'k11');
    assert.deepEqual(touched(['a', 'b'], 'b'), ['b', 'a']);
    assert.equal(entryOf(e, 'highway', { highway: 'track' }).id, 'highway:track');
    assert.equal(entryOf(e, 'highway', {}).id, 'highway:residential');
});
