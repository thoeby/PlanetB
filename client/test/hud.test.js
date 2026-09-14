// What an empty world says. The world is black until something is compiled,
// and black says nothing: this is the line in the middle of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STAGES, whatIsMissing } from '../js/hud.js';
import { GROUPS, LEAVES, TABS, keyed, surfaceOf } from '../js/tabbar.js';

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

// The chrome the design fixes (docs/design/chrome5.dc.html): three groups on
// one plinth, a key for everything, five stages.

test('every surface is in one of the three groups, and has a key of its own', () => {
    assert.deepEqual(GROUPS, ['you', 'main', 'system']);
    for (const t of TABS) {
        if (t.name === 'World') continue;
        assert.ok(GROUPS.includes(t.group), `${t.name} is in no group`);
        assert.match(t.key, /^[0-9`a-z]$/, `${t.name} has no key`);
    }
    const keys = TABS.map((t) => t.key).filter(Boolean);
    assert.equal(new Set(keys).size, keys.length, 'two surfaces share a key');
});

test('the groups hold what the design puts in them', () => {
    const of = (g) => TABS.filter((t) => t.group === g).map((t) => t.name);
    assert.deepEqual(of('you'), ['Profile', 'Wallet']);
    assert.deepEqual(of('main'),
        ['Place', 'Catalog', 'Your land', 'Publish', 'Work']);
    assert.deepEqual(of('system'), ['Setup', 'Share', 'Admin']);
});

test('the five surfaces the game is played through are on keys 1 to 5', () => {
    assert.deepEqual(TABS.filter((t) => t.group === 'main').map((t) => t.key),
        ['1', '2', '3', '4', '5']);
});

test('a key names its surface, and a key nobody bound names none', () => {
    assert.equal(keyed('1'), 'Place');
    assert.equal(keyed('4'), 'Publish');
    assert.equal(keyed('p'), 'Profile');
    assert.equal(keyed('`'), 'Setup');
    assert.equal(keyed('z'), null);
});

// Sending what you built and saying yes to what came back are one job, so they
// are one button with two tabs behind it — and each keeps its own name.
test('a part is reached through the surface that holds it', () => {
    assert.deepEqual(surfaceOf('Submit'), { tab: 'Publish', part: 'Submit' });
    assert.deepEqual(surfaceOf('Permission'), { tab: 'Publish', part: 'Permission' });
    assert.deepEqual(surfaceOf('Publish'), { tab: 'Publish', part: 'Submit' });
    assert.deepEqual(surfaceOf('Wallet'), { tab: 'Wallet', part: null });
    assert.equal(surfaceOf('nothing at all'), null);
});

test('every panel body there is, is a surface or a part of one', () => {
    assert.ok(LEAVES.includes('Submit') && LEAVES.includes('Permission'));
    assert.ok(!LEAVES.includes('Publish'), 'a surface with parts has no body');
    assert.equal(new Set(LEAVES).size, LEAVES.length, 'two bodies share a name');
});

test('the five stages are the route through the app, in order', () => {
    assert.deepEqual(STAGES.map((s) => s.label),
        ['Placed', 'In pool', 'Rendered', 'Awaiting', 'Published']);
});

test('every surface but the world itself says how wide its panel is', () => {
    for (const t of TABS) {
        if (t.name === 'World') continue;
        assert.ok(t.width >= 440, `${t.name} has no width`);
    }
});

// Work is a surface with queues behind it rather than one list: the machine
// strip is its own head (hud.js panelHead), because what this tab can do is
// the same answer whichever queue is open, and Render jobs is the only queue
// so far.
test('Work is a surface of queues, and Render jobs is the first', () => {
    assert.deepEqual(surfaceOf('Work'), { tab: 'Work', part: 'Render jobs' });
    assert.ok(LEAVES.includes('Render jobs'), 'the queue has a body of its own');
    assert.ok(!LEAVES.includes('Work'), 'and the surface is not a leaf');
});
