// EDT.21 — Save in Survey → Areas: the same kind overlapping becomes one area,
// another kind cuts a hole, and the save says what it did.
import test from 'node:test';
import assert from 'node:assert/strict';

import { sentence, settle } from '../js/areasave.js';
import { areaOf } from '../js/areasmodel.js';
import { areaOf as areaSize } from '../lib/polyops.js';

const square = (x, z, s) => [[[x, z], [x + s, z], [x + s, z + s], [x, z + s]]];
const forest = (polys, id = null) => areaOf({ id, kind: 'landuse',
    props: { landuse: 'forest' }, polys });

test('a new forest over a saved forest: one forest, and the saved one goes', () => {
    const old = forest([square(0, 0, 20)], 'f1');
    const add = forest([square(10, 10, 20)]);
    const areas = { items: [old, add] };
    const said = settle(areas);
    assert.equal(said.length, 1);
    assert.equal(sentence(said[0]), 'forest saved · merged with 1');
    assert.equal(old.state, 'deleted', 'the row it swallowed is taken away');
    assert.equal(add.polys.length, 1, 'one polygon');
    assert.ok(Math.abs(areaSize(add.polys) - 700) < 4, `area ${areaSize(add.polys)}`);
});

test('a meadow over a forest cuts a hole in it; apart, nothing happens', () => {
    const wood = forest([square(0, 0, 40)], 'f1');
    const meadow = areaOf({ kind: 'landuse', props: { landuse: 'meadow' },
        polys: [square(10, 10, 10)] });
    const pond = areaOf({ kind: 'natural', props: { natural: 'water' },
        polys: [square(100, 100, 5)] });
    const areas = { items: [wood, meadow, pond] };
    const said = settle(areas);
    assert.equal(wood.state, 'changed');
    assert.equal(wood.polys[0].length, 2, 'an outer ring and a hole');
    assert.ok(Math.abs(areaSize(wood.polys) - 1500) < 6);
    assert.equal(sentence(said.find((s) => s.area === meadow)), 'meadow saved · cut 1');
    assert.equal(sentence(said.find((s) => s.area === pond)), 'water saved');
});

test('the newest drawn wins: water drawn over a forest swallows it whole', () => {
    const small = forest([square(5, 5, 5)]);
    const big = areaOf({ kind: 'natural', props: { natural: 'water' },
        polys: [square(0, 0, 20)] });
    const areas = { items: [small, big] };
    const said = settle(areas);
    assert.deepEqual(areas.items, [big], 'the forest under the water is gone, unsaved');
    assert.equal(big.polys[0].length, 1, 'and the water has no hole');
    assert.deepEqual(said.map(sentence), ['water saved · cut 1']);
});
