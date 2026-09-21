// A zero-delay timer becomes a channel post, a real delay stays a timer, and
// a cleared one never runs (client/lib/quickyield.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { install, uninstall, yieldTask } from '../lib/quickyield.js';

function fakeGlobal() {
    const timers = [];
    return {
        MessageChannel: globalThis.MessageChannel,
        setTimeout: (fn, d, ...a) => { timers.push({ fn, d, a }); return timers.length; },
        clearTimeout: (id) => { timers[id - 1] = null; },
        timers,
    };
}

test('a zero-delay timer runs without the clock', async () => {
    const g = install(fakeGlobal());
    let ran = null;
    g.setTimeout((a, b) => { ran = a + b; }, 0, 1, 2);
    assert.equal(g.timers.length, 0, 'the clock was not asked');
    await yieldTask();
    await yieldTask();
    assert.equal(ran, 3);
    uninstall(g);
});

test('a timer with a delay is left to the clock, and a cleared post never runs', async () => {
    const g = install(fakeGlobal());
    g.setTimeout(() => {}, 250);
    assert.equal(g.timers.length, 1, 'a real delay is a timer');
    let ran = false;
    const id = g.setTimeout(() => { ran = true; }, 0);
    g.clearTimeout(id);
    await yieldTask();
    await yieldTask();
    assert.equal(ran, false);
    assert.equal(install(g), g, 'installing twice is once');
    uninstall(g);
    assert.equal(g.setTimeout(() => {}, 0), 2, 'and after that the clock has its timers back');
});
