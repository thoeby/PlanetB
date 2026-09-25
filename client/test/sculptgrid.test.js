// FND.9 — what a land's shaping is, and putting it back.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Shaping } from '../js/sculpt.js';
import { gridFor } from '../lib/r32.js';

const AREA = {
    id: '00000000-0000-0000-0000-000000000001',
    bbox: { west: 7.88, south: 46.29, east: 7.89, north: 46.30 },
    outline: { type: 'Polygon',
        coordinates: [[[7.88, 46.29], [7.89, 46.29], [7.89, 46.30], [7.88, 46.30],
            [7.88, 46.29]]] },
};

const made = () => new Shaping(AREA, gridFor([7.88, 46.29, 7.89, 46.30], 4));

test('ground nobody has moved says so, rather than saying nothing', () => {
    const it = made();
    const was = it.summary();
    assert.equal(was.cells, 0);
    assert.equal(was.lowest, 0);
    assert.equal(was.highest, 0);
    assert.ok(was.of > 0, 'it knows how many cells there are');
});

test('and ground that has been says how many cells, and how far', () => {
    const it = made();
    it.begin();
    for (const [k, v] of [[10, 2.5], [11, -1.25], [12, 0]]) {
        it.remember(k);
        it.grid.data[k] = v;
    }
    it.end();
    const now = it.summary();
    assert.equal(now.cells, 2, 'a cell set to nought is not a cell that moved');
    assert.equal(now.highest, 2.5);
    assert.equal(now.lowest, -1.25);
    assert.ok(now.metres > 0, 'and how much ground that is');
});

// There was no way back to the elevation at all: a land somebody flattened
// stayed flattened unless every cell was raised by hand.
test('putting the ground back is one stroke, and undo takes it back', () => {
    const it = made();
    it.begin();
    it.remember(10);
    it.grid.data[10] = 4;
    it.end();
    assert.equal(it.summary().cells, 1);

    assert.equal(it.clear(), 1, 'one cell was moved and one was put back');
    assert.equal(it.summary().cells, 0);
    assert.equal(it.strokes.length, 2, 'and it is a stroke like any other');

    it.undo();
    assert.equal(it.summary().cells, 1, 'undone, the shaping is back');
    assert.equal(it.grid.data[10], 4);
});

test('putting back ground that was never moved moves nothing', () => {
    const it = made();
    assert.equal(it.clear(), 0);
    assert.equal(it.summary().cells, 0);
});

// EDT.9 — the stroke stack: undo back to a stroke, redo forward to one, and
// the history's order and marks.
test('undo back to a stroke restores its cells exactly, and redo walks forward', async () => {
    const { dab } = await import('../js/sculptbrush.js');
    const s = made();
    const mid = { lon: 7.885, lat: 46.295 };
    const stroke = (brush) => {
        s.begin({ brush, size: 40 });
        dab(s, mid.lon, mid.lat, { brush, size: 40, strength: 1, dt: 1 });
        s.end();
    };
    stroke('raise');
    const afterFirst = s.grid.data.slice();
    stroke('raise');
    stroke('smooth');
    assert.equal(s.history().length, 3);
    assert.deepEqual(s.history().map((h) => h.n), [3, 2, 1]);
    assert.equal(s.undoTo(1), 2);
    assert.deepEqual([...s.grid.data], [...afterFirst], 'every cell as it was');
    assert.deepEqual(s.history().map((h) => [h.n, h.done]), [[3, false], [2, false], [1, true]]);
    assert.equal(s.history()[0].brush, 'smooth', 'the undone keep what they were');
    assert.equal(s.redoTo(2), 1);
    assert.deepEqual(s.history().map((h) => [h.n, h.done]), [[3, false], [2, true], [1, true]]);
    stroke('raise');
    assert.deepEqual(s.history().map((h) => [h.n, h.done]), [[3, true], [2, true], [1, true]],
        'a new stroke replaces the undone');
});
