// One dataset at a time per tab (client/js/workcaps.js capsFor): a z14's
// ground and frames are about a gigabyte, and four at once ran a tab out.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ALGO, capsFor } from '../js/workcaps.js';
import { WorkLoop } from '../js/work.js';

const CAPS = { webgpu: true, algo: ALGO };

test('a tab holding a dataset names none it could take', () => {
    const busy = capsFor(CAPS, null, [{ op: 'dataset' }, { op: 'train' }]);
    assert.equal(busy.algo.dataset, 'held');
    assert.equal(busy.algo.train, ALGO.train, 'the other ops are claimed as before');
    assert.equal(CAPS.algo.dataset, ALGO.dataset, 'the tab\'s own caps are not touched');
    assert.equal(capsFor(CAPS, null, [{ op: 'train' }]).algo.dataset, ALGO.dataset);
    assert.deepEqual(capsFor(CAPS, { lon: 8, lat: 47 }, []).near, { lon: 8, lat: 47 });
});

test('four lanes claiming at once are handed one dataset between them', async () => {
    let next = 1;
    const api = {
        token: () => 'jwt',
        // What claim_atom does with caps.algo (db/0178 tab_builds): a
        // dataset only to a tab that names dataset's version.
        rpc: async (name, { caps }) => {
            await new Promise((r) => { setTimeout(r, 1); });
            const op = caps.algo.dataset === ALGO.dataset ? 'dataset' : 'train';
            return { id: next++, op, algo_version: ALGO[op] };
        },
    };
    const loop = new WorkLoop({ api, caps: CAPS, lanes: 4 });
    const got = await Promise.all([1, 2, 3, 4].map(() => loop.claim()));
    assert.deepEqual(got.map((a) => a.op).sort(), ['dataset', 'train', 'train', 'train']);
    assert.equal(loop.working.size, 4, 'each claim is in hand before the next is asked');
});
