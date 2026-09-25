// EDT.13 — the kind picker's entries come from the vocabulary: one per kind
// and class for the geometry in hand, recent first, filtered by what is typed.
import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultsFrom, entriesFor, entryOf, guessOf, ordered, touched } from '../lib/kinds.js';

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

test('EDT.23: kind_default rows over the guesses; a blank width keeps the class width', () => {
    const rows = [{ kind: 'highway', width: null, corner: null, gradient: 9, hidden: false },
        { kind: 'barrier', width: 0.8, corner: false, gradient: null, hidden: false },
        { kind: 'landuse', width: null, corner: null, gradient: null, hidden: true }];
    const own = defaultsFrom(rows, { building: { hidden: true } });
    assert.deepEqual(own.highway, { gradient: 9 });
    assert.deepEqual(own.barrier, { width: 0.8, corner: false });
    assert.equal(own.landuse.hidden, true);
    assert.equal(own.building.hidden, true, 'what the editor hides itself stays hidden');
    const lines = entriesFor('line', KINDS, PROPS, own);
    assert.equal(entryOf(lines, 'highway', { highway: 'residential' }).width, 5,
        'the class width, since the operator left width blank');
    assert.equal(entryOf(lines, 'highway', { highway: 'residential' }).gradient, 9);
    assert.equal(entryOf(lines, 'barrier', { barrier: 'wall' }).corner, false);
    assert.deepEqual(entriesFor('polygon', KINDS, PROPS, own), [], 'landuse hidden');
    assert.deepEqual(guessOf('barrier'), { width: 0.5, corner: true, gradient: 100 });
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
