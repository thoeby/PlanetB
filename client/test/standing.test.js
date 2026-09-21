// The Work panel says what the pool thinks of this tab (db/0179 my_standing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { standingSaid } from '../js/worksettings.js';

test('a worker under the training line is told so, in one line', () => {
    const [said, tone] = standingSaid({ trust: 0.1, needs: { train: 0.3 } });
    assert.match(said, /trust 0.1 — under 0.3, so the pool hands this tab no training/);
    assert.equal(tone, 'bad');
});

test('a worker in good standing is just a number', () => {
    assert.deepEqual(standingSaid({ trust: 0.5, needs: { train: 0.3 } }), ['trust 0.5', '']);
    assert.deepEqual(standingSaid(null), ['not asked yet', '']);
    assert.deepEqual(standingSaid({ trust: null, needs: { train: 0.3 } }), ['not asked yet', '']);
});
