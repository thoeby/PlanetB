// Rules decide what a feature becomes; nothing in the compiler knows a species
// or a column name (client/lib/rules.js, db/0036_rules.sql).
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { matches, resolve, styleFor } from '../lib/rules.js';

const forest = (props) => ({ kind: 'forest', props });

const RULES = [
    { name: 'spruce', kind: 'forest', filter: [{ prop: 'species', op: 'in',
        value: ['picea', 'fichte', 'spruce'] }], style: { height: [18, 30], mature: 70 } },
    { name: 'young', kind: 'forest', filter: [{ prop: 'alter', op: 'lt', value: 20 }],
        style: { height: [2, 5] } },
    { name: 'any forest', kind: 'forest', filter: [], style: { height: [12, 22] } },
];

test('a condition compares words case- and language-blind', () => {
    assert.ok(matches(RULES[0], { species: 'Fichte' }));
    assert.ok(matches(RULES[0], { species: ' picea ' }));
    assert.ok(!matches(RULES[0], { species: 'Buche' }));
});

test('numbers compare as numbers even when the layer sends text', () => {
    assert.ok(matches(RULES[1], { alter: '12' }));
    assert.ok(!matches(RULES[1], { alter: '45' }));
    assert.ok(matches({ filter: [{ prop: 'h', op: 'eq', value: 3 }] }, { h: '3.0' }));
});

test('first match wins, and no conditions is the else-rule', () => {
    assert.equal(styleFor(RULES, forest({ species: 'fichte', alter: 5 }))._rule, 'spruce');
    assert.equal(styleFor(RULES, forest({ alter: 5 }))._rule, 'young');
    assert.equal(styleFor(RULES, forest({}))._rule, 'any forest');
});

test('a rule for another kind never matches', () => {
    assert.deepEqual(styleFor(RULES, { kind: 'road', props: {} }), {});
});

test('a disabled rule is skipped', () => {
    const off = [{ ...RULES[0], enabled: false }, RULES[2]];
    assert.equal(styleFor(off, forest({ species: 'picea' }))._rule, 'any forest');
});

test('a value can be read off the feature, with a fallback chain', () => {
    const chain = { prop: 'hoehe', else: { prop: 'levels', times: 3, else: 6 } };
    assert.equal(resolve(chain, { hoehe: '12,5' }), 12.5, 'a comma is a decimal point');
    assert.equal(resolve(chain, { levels: 4 }), 12);
    assert.equal(resolve(chain, {}), 6);
    assert.equal(resolve(chain, { hoehe: '' }), 6, 'an empty column is not a zero');
});

test('a number off the feature can be clamped', () => {
    const width = { prop: 'b', min: 2, max: 40, else: 5 };
    assert.equal(resolve(width, { b: 0.5 }), 2);
    assert.equal(resolve(width, { b: 400 }), 40);
});

test('a word can be read off the feature too', () => {
    const roof = { prop: 'dachform', text: true, else: 'flat' };
    assert.equal(resolve(roof, { dachform: 'Satteldach' }), 'Satteldach');
    assert.equal(resolve(roof, {}), 'flat');
});

test('an empty rule set styles nothing, and still answers', () => {
    assert.deepEqual(styleFor([], forest({ species: 'picea' })), {});
    assert.deepEqual(styleFor(undefined, forest({})), {});
});
