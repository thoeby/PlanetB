// What an empty world says. The world is black until something is compiled,
// and black says nothing: this is the line in the middle of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { whatIsMissing } from '../js/hud.js';
import { GROUPS, LEAVES, TABS, keyed, surfaceOf, wideAt } from '../js/tabbar.js';

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

// The chrome the design fixes (docs/design/chrome6.dc.html): two places a
// surface is opened from — the plinth along the bottom and the strip along the
// top — and a key for everything.

test('every surface is in one of the two groups, and has a key of its own', () => {
    assert.deepEqual(GROUPS, ['bar', 'top']);
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
    assert.deepEqual(of('bar'),
        ['Place', 'Catalog', 'Your land', 'Publish', 'Work']);
    assert.deepEqual(of('top'), ['Profile', 'Wallet', 'Settings']);
});

test('the five surfaces the game is played through are on keys 1 to 5', () => {
    assert.deepEqual(TABS.filter((t) => t.group === 'bar').map((t) => t.key),
        ['1', '2', '3', '4', '5']);
});

// v6 folds the small buttons into the three the strip has room for: sharing
// where you stand is something you hand out, and Setup and the admin tools are
// all "set once and left alone".
test('what used to be a button of its own is a tab of one of the three', () => {
    assert.deepEqual(surfaceOf('Share'), { tab: 'Profile', part: 'Share' });
    assert.deepEqual(surfaceOf('Setup'), { tab: 'Settings', part: 'Setup' });
    assert.deepEqual(surfaceOf('Land'), { tab: 'Settings', part: 'Land' });
    assert.deepEqual(surfaceOf('Vocabulary'), { tab: 'Settings', part: 'Vocabulary' });
    assert.deepEqual(surfaceOf('Settings'), { tab: 'Settings', part: 'Setup' });
});

// A panel is as wide as what it has to show, and Settings holds both kinds:
// a form in a column, and two tools that want the window.
test('a part says whether it takes the window, where its surface cannot', () => {
    assert.equal(wideAt('Setup'), false);
    assert.equal(wideAt('Land'), true);
    assert.equal(wideAt('Vocabulary'), true);
    assert.equal(wideAt('Place'), false);
});

test('a key names its surface, and a key nobody bound names none', () => {
    assert.equal(keyed('1'), 'Place');
    assert.equal(keyed('4'), 'Publish');
    assert.equal(keyed('p'), 'Profile');
    assert.equal(keyed('`'), 'Settings');
    assert.equal(keyed('9'), 'Share');
    assert.equal(keyed('0'), 'Land');
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

test('every surface but the world itself says how wide its panel is', () => {
    for (const t of TABS) {
        if (t.name === 'World') continue;
        // Or that it takes the window, which is the other answer to the same
        // question: a map beside a form has nothing to gain from a column.
        assert.ok(t.wide || t.parts?.some((p) => p.wide) || t.width >= 440,
            `${t.name} has no width`);
    }
});

// Work is a surface with queues behind it rather than one list (design 8):
// the machine strip is its own head (hud.js panelHead), because what this tab
// can do is the same answer whichever queue is open, and the queues are the
// kinds of work the pool sorts into — plus what this machine does with itself.
test('Work is a surface of queues, and every job is the first', () => {
    assert.deepEqual(surfaceOf('Work'), { tab: 'Work', part: 'Every job' });
    for (const part of ['Every job', 'Render jobs', 'Training', 'Publishing',
        'Machine']) {
        assert.ok(LEAVES.includes(part), `${part} has a body of its own`);
    }
    assert.ok(!LEAVES.includes('Work'), 'and the surface is not a leaf');
});
