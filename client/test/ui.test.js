// The pure parts of TASKS-ui.md: how far the camera stands from a product,
// how a land is drawn from above, the days a chart counts, and who has the
// bar's undo and redo.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { framing, sizeOf } from '../js/buildframe.js';
import { byDay } from '../js/market.js';
import { editSlot } from '../js/hudbar.js';
import { frameOf } from '../js/flowpaths.js';
import { onTermEnd } from '../js/duties.js';

test('a product is framed from a distance that fits its size, within reason', () => {
    assert.equal(sizeOf({ min: [0, 0, 0], max: [0.5, 0.4, 0.3] }), 0.5);
    assert.equal(sizeOf(null), 2, 'a product nobody measured is taken as two metres');
    assert.equal(framing(0.5).d, 4, 'a crate is not looked at from under a metre');
    assert.equal(framing(12).d, 30);
    assert.equal(framing(500).d, 80, 'nor a bridge from a kilometre');
    const f = framing(12);
    assert.ok(Math.abs(Math.hypot(f.back, f.up) - f.d) < 1e-9);
    assert.ok(f.pitch < 0, 'and the camera looks down at it');
});

test('a chart counts the last days, oldest first, and nothing outside them', () => {
    const now = new Date('2026-09-25T12:00:00Z');
    const rows = [{ created_at: '2026-09-25T08:00:00Z', qty: 2 },
        { created_at: '2026-09-24T23:00:00Z', qty: 1 },
        { created_at: '2026-08-01T00:00:00Z', qty: 9 }];
    const days = byDay(rows, { days: 3, now, value: (r) => r.qty });
    assert.deepEqual(days, [{ day: '2026-09-23', v: 0 }, { day: '2026-09-24', v: 1 },
        { day: '2026-09-25', v: 2 }]);
});

test('a land seen from above keeps its shape, and a click comes back as a place', () => {
    const f = frameOf({ west: 7, east: 7.001, south: 46, north: 46.001 });
    const [x, y] = f.xy([7.0005, 46.0005]);
    const back = f.lonlat([x, y]);
    assert.ok(Math.abs(back[0] - 7.0005) < 1e-12 && Math.abs(back[1] - 46.0005) < 1e-12);
    const [w] = f.xy([7.001, 46]);
    const [, h] = f.xy([7, 46]);
    // A thousandth of a degree east is shorter than one north, at 46° N.
    assert.ok(Math.abs(w / h - Math.cos(46.0005 * Math.PI / 180)) < 1e-3);
});

test('the bar’s undo belongs to the first editor on screen, and to nobody otherwise', () => {
    const edit = { node: { hidden: false }, undo: { disabled: false },
        redo: { disabled: false } };
    const slot = editSlot(edit);
    assert.equal(edit.node.hidden, true, 'nobody editing, no buttons');
    let ground = 0;
    let terrainOpen = false;
    slot.use('ground', { live: () => terrainOpen, undo: () => { ground++; },
        canUndo: () => true, canRedo: () => false });
    assert.equal(edit.node.hidden, true, 'the ground is not on screen');
    terrainOpen = true;
    slot.changed();
    assert.equal(edit.node.hidden, false);
    assert.equal(edit.redo.disabled, true);
    edit.undo.onclick();
    assert.equal(ground, 1);
    let flow = 0;
    slot.use('automate', { undo: () => { flow++; }, canUndo: () => true });
    slot.use('ground', null);
    edit.undo.onclick();
    assert.deepEqual([ground, flow], [1, 1]);
    slot.use('automate', null);
    assert.equal(edit.node.hidden, true);
});

test('a list is read again a second after the next term on it ends, and only then', () => {
    const now = Date.now();
    const rows = [{ ends_at: new Date(now - 5000).toISOString() }, { ends_at: null },
        { ends_at: new Date(now + 60_000).toISOString() },
        { ends_at: new Date(now + 20_000).toISOString() }];
    const set = [];
    const real = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => { set.push(ms); return 7; };
    try {
        assert.equal(onTermEnd(rows, () => {}), 7);
        assert.equal(onTermEnd([{ ends_at: null }], () => {}), null, 'nothing ends: no timer');
    } finally { globalThis.setTimeout = real; }
    assert.equal(set.length, 1);
    assert.ok(set[0] > 20_000 && set[0] <= 21_000, `waits for the nearest end (${set[0]} ms)`);
});
