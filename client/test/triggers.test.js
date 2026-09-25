// The page notices a firing and says it once (LV.2, client/js/triggers.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { edges, Triggers } from '../js/triggers.js';

const gate = { id: 'g', san: 'SGATE', name: 'Tor',
    parts: { triggers: [{ kind: 'near', params: { m: 5 } },
        { kind: 'far', params: { m: 5 } }, { kind: 'use', params: { part: 'bar' } },
        { kind: 'key', params: { key: 'g', when: 'down' } }] } };

const recorder = () => {
    const calls = [];
    let t = 1000;
    const tr = new Triggers({
        rpc: async (fn, args) => { calls.push([fn, args]); return calls.length; },
        clock: () => t });
    return { tr, calls, tick: (s) => { t += s; } };
};

test('near fires on the way in, far on the way out, never twice in a row', () => {
    const near = [{ kind: 'near', params: { m: 5 } }];
    assert.equal(edges(near, 20, 4).length, 1);
    assert.equal(edges(near, 4, 3).length, 0, 'still inside is not another arrival');
    assert.equal(edges([{ kind: 'far', params: { m: 5 } }], 4, 6).length, 1);
    assert.equal(edges([{ kind: 'far', params: { m: 5 } }], undefined, 6).length, 0,
        'first seen far away is not a departure');
});

test('walking up to a gate sets it off once, and leaving sets off far', async () => {
    const { tr, calls, tick } = recorder();
    await tr.move([{ row: gate, metres: 20 }]);
    await tr.move([{ row: gate, metres: 4 }]);
    tick(0.1);
    await tr.move([{ row: gate, metres: 3 }]);
    assert.deepEqual(calls.map(([, a]) => a.p_kind), ['near']);
    tick(2);
    await tr.move([{ row: gate, metres: 9 }]);
    assert.deepEqual(calls.map(([, a]) => a.p_kind), ['near', 'far']);
});

test('use and a key reach only an arm\'s length', async () => {
    const { tr, calls } = recorder();
    await tr.use([{ row: gate, metres: 10 }]);
    await tr.key('g', 'down', [{ row: gate, metres: 10 }]);
    assert.equal(calls.length, 0);
    await tr.use([{ row: gate, metres: 2 }]);
    await tr.key('G', 'down', [{ row: gate, metres: 2 }]);
    await tr.key('g', 'up', [{ row: gate, metres: 2 }]);
    assert.deepEqual(calls.map(([, a]) => [a.p_kind, a.p_part]), [['use', 'bar'], ['key', null]]);
    assert.deepEqual(tr.offers([{ row: gate, metres: 2 }]).map((o) => o.key), ['E', 'G']);
});

test('a click on something that does not listen for one says nothing', async () => {
    const { tr, calls } = recorder();
    await tr.click(gate);
    assert.equal(calls.length, 0);
});
