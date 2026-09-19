// What a job's card says about it (design 8): the sentence, the counts and the
// bar. The card itself is DOM and is looked at through the page; this is the
// part of it that decides what the words are.

import test from 'node:test';
import assert from 'node:assert/strict';

import { pieces, share, statusOf, stepsOf } from '../js/poolcard.js';

const job = (over = {}) => ({
    job: 1, z: 14, x: 8548, y: 5801, phase: 'render', made: 'assembled',
    bounty: 0, ready: 1, blocked: 2, claimed: 0, failed: 0, handed_back: 0,
    frames: 0, frames_done: 0, may_retry: false, ...over,
});

test('the card says which end of the tile it is waiting at', () => {
    assert.equal(statusOf(job()), 'assembled · waiting to be drawn');
    assert.equal(statusOf(job({ phase: 'train', made: 'trained' })),
        'trained · waiting to be trained');
    assert.equal(statusOf(job(), 'framing'), 'framing on this machine');
});

test('a job nobody can take says so, and says whose it is to put right', () => {
    assert.equal(statusOf(job({ ready: 0, failed: 2 })),
        'stopped · its owner can try again');
    assert.equal(statusOf(job({ ready: 0, failed: 2, may_retry: true })),
        'stopped · start it over or drop it');
    // A piece in somebody's hands is not a stopped tile.
    assert.equal(statusOf(job({ ready: 0, claimed: 1, failed: 1 })),
        'assembled · waiting to be drawn');
});

test('the counts leave out the zeroes, and the frames come first', () => {
    assert.equal(pieces(job({ frames: 3, frames_done: 1, ready: 1, blocked: 2 })),
        '1/3 frames · 1 ready · 2 waiting');
    assert.equal(pieces(job({ ready: 0, blocked: 0, claimed: 2 })), '2 in hand');
    assert.equal(pieces(job({ ready: 0, blocked: 0, failed: 1, handed_back: 3 })),
        '1 failed · handed back 3×');
});

test('the steps are the chain, in the words the panel uses for them', () => {
    const steps = stepsOf(job({ steps: [
        { op: 'assemble', done: 1, total: 1, state: 'done' },
        { op: 'frame', done: 2, total: 3, state: 'to do' },
        { op: 'train', done: 0, total: 1, state: 'waiting' },
        { op: 'sog', done: 0, total: 1, state: 'waiting' },
    ] }));
    assert.deepEqual(steps.map((s) => s.word),
        ['ground', 'frames', 'training', 'packing']);
    // Only a step that is more than one piece carries a count: "ground 1/1"
    // is noise on every card in the pool.
    assert.deepEqual(steps.map((s) => s.count), ['', '2/3', '', '']);
    assert.equal(steps[1].state, 'to do');
    assert.deepEqual(stepsOf(job()), [], 'a row from before the steps says nothing');
});

test('the bar is the frames, and a tile without frames has none', () => {
    assert.equal(share(job({ frames: 4, frames_done: 3 })), 75);
    assert.equal(share(job({ frames: 0 })), null, 'a merge draws no bar');
});
