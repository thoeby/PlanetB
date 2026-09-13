// The altimeter: what the ladder says, without a browser to draw it on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ladderOf, stepFor } from '../js/altimeter.js';

test('standing on the ground reads in metres, flying reads in kilometres', () => {
    assert.equal(stepFor(0), 5);
    assert.equal(stepFor(16), 10);
    assert.equal(stepFor(900), 500);
    // However high you get, the ladder still has a division.
    assert.ok(stepFor(1e7) > 0);
});

test('you are always in the middle of the ladder, whatever it is showing', () => {
    const lad = ladderOf({ altitude: 1812, above: 16, height: 300 });
    assert.equal(lad.mid, 150);
    // The rungs run down the ladder, the numbers going up as they rise.
    assert.ok(lad.marks.length >= 10);
    for (const m of lad.marks) assert.ok(m.y >= 0 && m.y <= 300);
    for (let i = 1; i < lad.marks.length; i++) {
        assert.ok(lad.marks[i].m > lad.marks[i - 1].m, 'the numbers go up');
        assert.ok(lad.marks[i].y < lad.marks[i - 1].y, 'and up is up the screen');
    }
    // Every second rung carries its number, so the ladder is readable and not
    // a wall of digits.
    assert.ok(lad.marks.every((m) => m.labelled === (m.m % (lad.step * 2) === 0)));
});

test('the ground is drawn below you by exactly how far above it you are', () => {
    const lad = ladderOf({ altitude: 1812, above: 16, height: 300 });
    assert.ok(lad.ground > lad.mid, 'the ground is under you, not over you');
    assert.equal(Math.round(lad.ground - lad.mid), Math.round(16 * lad.ppm));
});

test('ground too far below to draw is not drawn, and unknown ground is not invented', () => {
    assert.equal(ladderOf({ altitude: 3000, above: null, height: 300 }).ground, null);
    // A step is chosen to keep the ground on the ladder, so it takes a drop
    // bigger than the instrument can hold to lose it.
    const deep = ladderOf({ altitude: 9000, above: 1e9, height: 300 });
    assert.equal(deep.ground, null);
});
