// What an empty world says. The world is black until something is compiled,
// and black says nothing: this is the line in the middle of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GROUPS, STAGES, TABS, keyed, whatIsMissing } from '../js/hud.js';

test('with no ground at all, the world has nowhere to be', () => {
    assert.match(whatIsMissing({}), /Setup/);
});

test('with ground but nothing drawn, the next move is QGIS', () => {
    assert.match(whatIsMissing({ coverage: 'ch:alti' }), /QGIS/);
});

test('with land drawn but nothing compiled, the next move is Submit', () => {
    const said = whatIsMissing({ coverage: 'ch:alti', areas: 1, mine: 1 });
    assert.match(said, /Submit/);
});

test('standing on somebody else\'s uncompiled land is not your job', () => {
    const said = whatIsMissing({ coverage: 'ch:alti', areas: 1, mine: 0 });
    assert.match(said, /none of the land is yours/);
});

test('a world with a published tile in it says nothing', () => {
    assert.equal(whatIsMissing({ coverage: 'ch:alti', areas: 1, mine: 1, published: 1 }), '');
});

test('land with nothing on it has nothing to compile', () => {
    const said = whatIsMissing({ coverage: 'ch:alti', areas: 1, mine: 1, things: 0 });
    assert.match(said, /draw a road, a wood or a building/);
});

test('land with something on it is a Submit away', () => {
    const said = whatIsMissing({ coverage: 'ch:alti', areas: 1, mine: 1, things: 4 });
    assert.match(said, /Submit/);
});

// The chrome the design fixes: four groups, a key for every tab, five stages.

test('every tab is in one of the four groups, and has a key of its own', () => {
    assert.deepEqual(GROUPS, ['Look', 'Build', 'Economy', 'System']);
    for (const t of TABS) {
        assert.ok(GROUPS.includes(t.group), `${t.name} is in no group`);
        assert.match(t.key, /^[0-9`]$/, `${t.name} has no key`);
    }
    const keys = TABS.map((t) => t.key);
    assert.equal(new Set(keys).size, keys.length, 'two tabs share a key');
});

test('the groups hold what the design puts in them', () => {
    const of = (g) => TABS.filter((t) => t.group === g).map((t) => t.name);
    assert.deepEqual(of('Look'), ['World', 'Share']);
    assert.deepEqual(of('Build'), ['Your land', 'Place', 'Catalog', 'Submit']);
    assert.deepEqual(of('Economy'), ['Render pool', 'Permission', 'Wallet']);
    assert.deepEqual(of('System'), ['Admin', 'Setup']);
});

test('a key names its tab, and a key nobody bound names none', () => {
    assert.equal(keyed('1'), 'World');
    assert.equal(keyed('7'), 'Permission');
    assert.equal(keyed('`'), 'Setup');
    assert.equal(keyed('q'), null);
});

test('the five stages are the route through the app, in order', () => {
    assert.deepEqual(STAGES.map((s) => s.label),
        ['Placed', 'In pool', 'Rendered', 'Awaiting', 'Published']);
});

test('every tab but the world itself says how wide its panel is', () => {
    for (const t of TABS) {
        if (t.name === 'World') continue;
        assert.ok(t.width >= 440, `${t.name} has no width`);
    }
});
