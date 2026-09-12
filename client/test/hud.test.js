// What an empty world says. The world is black until something is compiled,
// and black says nothing: this is the line in the middle of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { whatIsMissing } from '../js/hud.js';

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
