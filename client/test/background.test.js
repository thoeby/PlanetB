// WP5.2 — what a tab that is also being played offers the world: a position
// that rides along with the claim, and a frame budget that holds the next atom
// back. client/test/e2e/background.spec.js is the same two against the real
// database.

import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkLoop } from '../js/work.js';

const CAPS = { webgpu: false, vram_gb: 0 };

function fakeLoop({ pace, where, claim = null } = {}) {
    const calls = [];
    const timers = {
        setInterval: () => 1,
        clearInterval: () => {},
        setTimeout: (fn, ms) => { calls.push(['wait', ms]); return setTimeout(fn, 0); },
    };
    const api = {
        token: () => 'jwt',
        select: async () => [],
        rpc: async (name, args) => {
            calls.push(['rpc', name, args]);
            return name === 'claim_atom' ? claim : null;
        },
    };
    return { calls, loop: new WorkLoop({ api, caps: CAPS, timers, pace, where }) };
}

test('the player position travels with the claim, not with the worker row', async () => {
    const at = { lon: 8.04, lat: 47.39 };
    const { calls, loop } = fakeLoop({ where: () => at });
    await loop.step();
    assert.deepEqual(calls[0], ['rpc', 'claim_atom', { caps: { ...CAPS, near: at } }]);
});

test('a tab with nowhere to be asks for work anywhere', async () => {
    const { calls, loop } = fakeLoop();
    await loop.step();
    assert.deepEqual(calls[0][2], { caps: CAPS }, 'no near, so no ordering by distance');
});

test('a position that has gone away is not sent stale', async () => {
    let at = { lon: 8, lat: 47 };
    const { calls, loop } = fakeLoop({ where: () => at });
    await loop.step();
    at = null;
    await loop.step();
    assert.ok(calls[0][2].caps.near, 'the first claim carried it');
    assert.equal(calls[1][2].caps.near, undefined, 'the second did not');
});

test('a tab drawing below the frame budget waits instead of claiming', async () => {
    let slow = true;
    const { calls, loop } = fakeLoop({ pace: () => (slow ? 2000 : 0) });
    const run = loop.start();
    // Two waits are enough to show it is the pace holding it back and not one
    // stray tick; the claim only happens once the tab is fast again.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls.filter((c) => c[0] === 'wait').length > 0, true);
    assert.equal(calls.some((c) => c[1] === 'claim_atom'), false,
        'nothing was claimed while the tab was busy drawing');
    slow = false;
    await new Promise((r) => setTimeout(r, 5));
    loop.stop();
    await run;
    assert.equal(calls.some((c) => c[1] === 'claim_atom'), true,
        'and the work resumes once the frames are cheap again');
    assert.deepEqual(calls.filter((c) => c[0] === 'wait').map((c) => c[1])[0], 2000);
});
