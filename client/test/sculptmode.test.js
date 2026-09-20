// FND.9 — what the Shape panel says about the brush in hand, and the keys the
// buttons print. The ring itself is drawn by PlayCanvas and is a browser test;
// what it is drawn from is here.
import test from 'node:test';
import assert from 'node:assert/strict';

import { BRUSH_SAYS, brushLine, brushUses, groundLine, keyHandler, shapedLine }
    from '../js/sculptmode.js';
import { BRUSHES } from '../js/sculpt.js';

test('every brush says what it does, and which numbers it reads', () => {
    for (const b of BRUSHES) {
        assert.ok(BRUSH_SAYS[b.id]?.does, `${b.id} says nothing about itself`);
        assert.ok(Array.isArray(BRUSH_SAYS[b.id].uses), `${b.id} names no fields`);
    }
    assert.equal(brushUses('raise', 'strength'), true);
    // Strength does nothing to a brush that pulls towards a mean or a height.
    assert.equal(brushUses('smooth', 'strength'), false);
    assert.equal(brushUses('level', 'target'), true);
    assert.equal(brushUses('raise', 'target'), false);
});

test('the line under the brushes says what a drag will do', () => {
    assert.equal(brushLine({ brush: 'raise', size: 12, strength: 0.5 }),
        'Pulls the ground up under the brush, softer towards its edge.'
        + ' 12 m across · 0.5 m a dab');
    // And says nothing about a number the brush does not read.
    assert.match(brushLine({ brush: 'smooth', size: 20, strength: 9 }), /20 m across$/);
    assert.doesNotMatch(brushLine({ brush: 'smooth', size: 20, strength: 9 }), /a dab/);
});

// A tiny stand-in for a keyboard event.
const press = (key, more = {}) => ({ key, target: null, preventDefault() {}, ...more });

test('the keys the buttons print are the keys that work', () => {
    const got = [];
    const state = { on: true, size: 20 };
    const keys = keyHandler(state, { brush: (b) => got.push(['brush', b]),
        size: (n) => got.push(['size', n]),
        undo: () => got.push(['undo']), redo: () => got.push(['redo']) });
    for (const b of BRUSHES) keys(press(b.key.toUpperCase()));
    assert.deepEqual(got.map(([, id]) => id), BRUSHES.map((b) => b.id));

    got.length = 0;
    keys(press(']'));
    keys(press('['));
    assert.deepEqual(got, [['size', 25], ['size', 16]]);

    got.length = 0;
    keys(press('z', { ctrlKey: true }));
    keys(press('z', { ctrlKey: true, shiftKey: true }));
    assert.deepEqual(got, [['undo'], ['redo']]);
});

test('and they are dead while shaping is off, or while somebody is typing', () => {
    const got = [];
    const acts = { brush: (b) => got.push(b), size: () => got.push('size'),
        undo: () => got.push('undo'), redo: () => got.push('redo') };
    keyHandler({ on: false, size: 12 }, acts)(press('r'));
    assert.deepEqual(got, [], 'a key does nothing while shaping is off');

    const field = { closest: (sel) => (sel.includes('input') ? {} : null) };
    keyHandler({ on: true, size: 12 }, acts)(press('r', { target: field }));
    assert.deepEqual(got, [], 'and nothing while a field has the keyboard');
});

// What the panel could not say at all: what is under the brush, and what has
// already been done to this land's ground.
test('the line under the brush says the height here, and the shaping on it', () => {
    const ground = (lon) => (lon === 7.88 ? 652.4 : 600);
    const shaping = { at: () => 2.4 };
    const at = { lon: 7.88, lat: 46.29 };
    assert.match(groundLine({ at, shaping, inside: true }, ground), /654\.8 m here/);
    assert.match(groundLine({ at, shaping, inside: true }, ground), /\+2\.40 m of shaping/);
    // Ground nobody has shaped says so rather than "+0.00 m".
    assert.match(groundLine({ at, shaping: { at: () => 0 }, inside: true }, ground),
        /as the elevation gave it/);
    // Off the land, and off the ground entirely.
    assert.match(groundLine({ at, shaping, inside: false }, ground), /not this land/);
    assert.equal(groundLine({ at: null }, ground), '');
    assert.match(groundLine({ at, shaping }, () => NaN), /no ground under the pointer/);
});

test('and what has been done to the land altogether, and by whom', () => {
    const summary = { cells: 1200, of: 65536, lowest: -3.2, highest: 5.1, metres: 4800 };
    assert.match(shapedLine({ summary: () => summary, was: { rev: 3, who: 'Ben' } }),
        /revision 3 · last shaped by Ben/);
    assert.match(shapedLine({ summary: () => summary, was: { rev: 3, mine: true } }),
        /last shaped by you/);
    assert.match(shapedLine({ summary: () => summary, was: null }), /never shaped before/);
    assert.match(shapedLine({ summary: () => summary, was: null }),
        /1,200 cells moved \(4,800 m²\), from -3\.2 to \+5\.1 m/);
    // Ground as the elevation gave it says that, not "0 cells moved".
    assert.match(shapedLine({ summary: () => ({ ...summary, cells: 0 }), was: null }),
        /nothing is moved off the elevation/);
    assert.equal(shapedLine(null), '');
});
