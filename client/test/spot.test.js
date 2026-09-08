// The owner's spot check (client/js/spot.js). The server decides what is due;
// this is about the tab doing what it is told, once, and reporting the answer.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SpotChecker } from '../js/spot.js';

// Enough of client/js/api.js for the checker: RPCs answer from a script, and
// every call is recorded.
function fakeApi(answers) {
    const calls = [];
    return {
        calls,
        token: () => 'jwt',
        rpc: async (name, args) => {
            calls.push([name, args]);
            const a = answers[name];
            return typeof a === 'function' ? a(args) : a;
        },
        select: async (table, q) => {
            calls.push(['select', table, q]);
            return answers.select?.[table] ?? [];
        },
    };
}

const DUE = {
    kind: 'perceptual', atom_id: 77,
    inputs: { sog: 12, frames: [10, 11] },
    params: { index: 1, min_psnr: 22, camera_set: 'z16-v1' },
};

const cache = { load: async (r) => r };
const worker = (result) => () => ({
    run: async () => ({ files: [], output: null, result }),
    terminate: () => {},
});

const row = { z: 16, x: 3, y: 4, sog_sha256: 'a'.repeat(64) };

test('a tile the server has nothing to say about is left alone', async () => {
    const api = fakeApi({ spot_due: [] });
    const spot = new SpotChecker({ api, cache, spawn: worker({}) });
    assert.equal(await spot.check(row), null);
    assert.deepEqual(api.calls.map((c) => c[0]), ['spot_due']);
});

test('a deterministic tile is asked for again rather than looked at', async () => {
    const api = fakeApi({
        spot_due: [{ kind: 'hash', atom_id: 5, inputs: {}, params: {} }],
        recheck_atom: true,
    });
    const spot = new SpotChecker({ api, cache, spawn: worker({}) });
    const out = await spot.check({ ...row, z: 12 });
    assert.deepEqual(out, { kind: 'hash', atom: 5, again: true });
    assert.deepEqual(api.calls.map((c) => c[0]), ['spot_due', 'recheck_atom']);
});

test('a trained tile is rendered and the answer submitted as a spot check',
    async () => {
        const api = fakeApi({
            spot_due: [DUE],
            select: { atom: [10, 11, 12].map((id) => ({ id, output_sha256: 'b'.repeat(64),
                result: { path: `/jobs/${id}/x` } })) },
            submit_verification: 'verified',
        });
        const spot = new SpotChecker({ api, cache,
            spawn: worker({ passed: true, psnr: 31.2, poses: [7, 21] }) });
        const out = await spot.check(row);
        assert.equal(out.passed, true);
        const [name, args] = api.calls.at(-1);
        assert.equal(name, 'submit_verification');
        assert.equal(args.atom_id, 77);
        assert.equal(args.passed, true);
        assert.equal(args.spot, true);
        assert.equal(args.metrics.psnr, 31.2);
    });

test('a failure is reported as a failure, not swallowed', async () => {
    const api = fakeApi({
        spot_due: [DUE], submit_verification: 'suspect',
        select: { atom: [10, 11, 12].map((id) => ({ id, output_sha256: 'b'.repeat(64),
            result: { path: `/jobs/${id}/x` } })) },
    });
    const spot = new SpotChecker({ api, cache,
        spawn: worker({ passed: false, psnr: 8.3, poses: [7, 21] }) });
    const out = await spot.check(row);
    assert.equal(out.passed, false);
    assert.equal(out.state, 'suspect');
    assert.equal(spot.flagged, 1);
    assert.equal(api.calls.at(-1)[1].passed, false);
});

test('a tile is offered once per published version, and one per sweep',
    async () => {
        let due = [DUE];
        const api = fakeApi({ spot_due: () => due, submit_verification: 'verified',
            select: { atom: [10, 11, 12].map((id) => ({ id,
                output_sha256: 'b'.repeat(64), result: { path: `/jobs/${id}/x` } })) } });
        const spot = new SpotChecker({ api, cache,
            spawn: worker({ passed: true, psnr: 30, poses: [7, 21] }) });
        const rows = [row, { ...row, x: 4 }];
        assert.ok(await spot.sweep(rows), 'the first sweep checks one tile');
        assert.equal(spot.checked, 1, 'and only one');
        due = [];
        await spot.sweep(rows);
        assert.equal(api.calls.filter((c) => c[0] === 'spot_due').length, 2,
            'the tile already checked is not asked about again');
        const swapped = { ...row, sog_sha256: 'c'.repeat(64) };
        due = [DUE];
        await spot.sweep([swapped]);
        assert.equal(spot.checked, 2, 'a republished tile is a new tile');
    });

test('a tab that changes hands has seen nothing', async () => {
    const api = fakeApi({ spot_due: [], select: {} });
    const spot = new SpotChecker({ api, cache, spawn: worker({}) });
    await spot.sweep([row]);
    await spot.sweep([row]);
    assert.equal(api.calls.length, 1, 'the same user asks once');
    api.token = () => 'another';
    await spot.sweep([row]);
    assert.equal(api.calls.length, 2, 'somebody else asks again');
});

test('an anonymous tab checks nothing', async () => {
    const api = fakeApi({ spot_due: [DUE] });
    api.token = () => null;
    const spot = new SpotChecker({ api, cache, spawn: worker({}) });
    assert.equal(await spot.sweep([row]), null);
    assert.deepEqual(api.calls, []);
});
