// joint.js says what db/0200 says (the pgTAP test checks the same numbers).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { arrivesAt, jointAt, pathAt, poseAt, REST, spinAt } from '../lib/joint.js';

test('a pose goes from where it was towards where it is told, in time', () => {
    const v = { to: { yaw: 90 }, over_s: 4 };
    assert.equal(poseAt(v, REST, 100, 102).yaw, 45);
    assert.equal(poseAt(v, REST, 100, 200).yaw, 90);
    assert.equal(poseAt(v, REST, 100, 99).yaw, 0);
    assert.equal(poseAt(v, { ...REST, x: 3 }, 100, 102).x, 3, 'what it is not told stays');
    assert.equal(poseAt({ to: { yaw: 10 } }, REST, 100, 100).yaw, 10, 'no time is at once');
});

test('a spin turns rpm times a minute from its start', () => {
    assert.equal(spinAt({ axis: 'y', rpm: 10 }, REST, 100, 101.5).yaw, 90);
    assert.equal(spinAt({ axis: 'x', rpm: 60 }, REST, 0, 0.25).pitch, 90);
});

test('a path is walked metre by metre, and round again when it loops', () => {
    const v = { route_m: [[0, 0, 0], [10, 0, 0], [10, 0, 10]], speed: 2, loop: false };
    assert.equal(pathAt(v, 100, 107.5).z, 5);
    assert.equal(pathAt(v, 100, 1000).z, 10, 'and stops at the end');
    assert.equal(pathAt({ route_m: [[0, 0, 0], [10, 0, 0]], speed: 2, loop: true },
        100, 106).x, 2);
});

test('the latest motion told to a part is the one it follows', () => {
    const rows = [
        { type: 'pose', value: { to: { yaw: 90 }, over_s: 0 }, start: REST, clock: 10, rev: 1 },
        { type: 'spin', value: { axis: 'y', rpm: 0 }, start: { ...REST, yaw: 30 },
            clock: 20, rev: 2 },
    ];
    assert.equal(jointAt(rows, 30).yaw, 30);
    assert.deepEqual(jointAt([], 30), REST);
});

test('a pose arrives over_s after it was told', () => {
    assert.equal(arrivesAt('pose', { to: { yaw: 90 }, over_s: 4 }, 100), 104);
    assert.equal(arrivesAt('spin', { rpm: 1 }, 100), Infinity);
});
