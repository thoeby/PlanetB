// WP2.2 — the worker loop, without a browser: input resolution, the input
// cache, and one atom claimed, run, uploaded, registered and submitted.
// client/test/e2e/work.spec.js is the same loop against the real database,
// the real file store and a real Web Worker.

import test from 'node:test';
import assert from 'node:assert/strict';

import { InputCache, resolveInputs } from '../js/inputs.js';
import { WorkLoop } from '../js/work.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

// A stand-in for js/api.js: canned rows, and a record of every call.
function fakeApi(rows = {}, rpcs = {}) {
    const calls = [];
    return {
        calls,
        token: () => 'jwt',
        select: async (table, params) => {
            calls.push(['select', table, params]);
            return (rows[table] ?? []).filter((r) => match(r, params));
        },
        rpc: async (name, args) => {
            calls.push(['rpc', name, args]);
            const v = rpcs[name];
            return typeof v === 'function' ? v(args) : v;
        },
    };
}

// Enough of PostgREST's filter syntax for these tests: eq. and in.().
function match(row, params = {}) {
    for (const [key, filter] of Object.entries(params)) {
        if (key === 'select' || typeof filter !== 'string') continue;
        if (filter.startsWith('eq.')) {
            if (String(row[key]) !== filter.slice(3)) return false;
        } else if (filter.startsWith('in.(')) {
            const set = filter.slice(4, -1).split(',');
            if (!set.includes(String(row[key]))) return false;
        }
    }
    return true;
}

test('an atom id resolves to the output its producer uploaded', async () => {
    const api = fakeApi({ atom: [{ id: 7, output_sha256: SHA_A }] });
    assert.deepEqual(await resolveInputs(api, { ply: 7, snapshot: 'deadbeef' }),
        { ply: `/jobs/7/${SHA_A}`, snapshot: 'deadbeef' });
});

test('a child sog resolves through the tile that publishes it', async () => {
    const api = fakeApi({
        artifact: [{ sha256: SHA_A, kind: 'sog' }, { sha256: SHA_B, kind: 'glb' }],
        tile: [{ z: 12, x: 4, y: 5, sog_sha256: SHA_A }],
    });
    const got = await resolveInputs(api, { children: [SHA_A, ''], glb: [SHA_B] });
    assert.deepEqual(got, {
        children: [`/tiles/12/4/5/${SHA_A}.sog`, ''],
        glb: [`/assets/${SHA_B}.glb`],
    });
});

test('an input the producer has not finished is an error, not a null', async () => {
    const api = fakeApi({ atom: [{ id: 7, output_sha256: null }] });
    await assert.rejects(() => resolveInputs(api, { ply: 7 }), /produced no output/);
});

test('the input cache fetches a url once', async () => {
    let n = 0;
    const cache = new InputCache({
        filesUrl: 'http://files',
        fetchFn: async () => { n += 1; return new Response(new Uint8Array([1, 2, 3])); },
    });
    const first = await cache.load({ ply: '/jobs/1/x', keep: 'as-is' });
    assert.equal(new Uint8Array(first.ply)[2], 3);
    assert.equal(first.keep, 'as-is');
    await cache.bytes('/jobs/1/x');
    assert.equal(n, 1, 'the second read came from the cache');
});

const ATOM = {
    id: 42, job_id: 9, op: 'noop', algo_version: 'noop-v1', atom_hash: SHA_A,
    inputs: {}, params: {}, seed: 0,
};

// One atom, start to finish, with the file store and the Web Worker faked.
function loopOver(atom, { rpcs = {}, spawnOut } = {}) {
    const puts = [];
    const api = fakeApi({ artifact: [] }, {
        claim_atom: atom, submit_atom: 'verified', register_artifact: SHA_A, ...rpcs,
    });
    const loop = new WorkLoop({
        api,
        filesUrl: 'http://files',
        spawn: () => ({ run: async () => spawnOut, terminate: () => {} }),
        fetchFn: async (url, opts) => {
            puts.push([url, opts.method, opts.headers['X-Sha256']]);
            return new Response('', { status: 201 });
        },
        timers: { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => {} },
    });
    return { loop, api, puts };
}

const OUT = {
    files: [{ ext: 'json', kind: 'ply', bytes: new TextEncoder().encode('{"a":1}') }],
    output: 'json',
    result: { splat_count: 0 },
};

test('a claimed atom is uploaded to the path its claim reserved, then submitted', async () => {
    const { loop, api, puts } = loopOver(ATOM, { spawnOut: OUT });
    assert.equal(await loop.step(), 'verified');

    assert.equal(puts.length, 1);
    const [url, method, declared] = puts[0];
    assert.equal(method, 'PUT');
    assert.match(url, /^http:\/\/files\/jobs\/42\/[0-9a-f]{64}\.json$/);
    assert.equal(url.split('/').pop(), `${declared}.json`,
        'the declared sha256 is the name it is written under');

    const rpcs = api.calls.filter((c) => c[0] === 'rpc').map((c) => c[1]);
    assert.deepEqual(rpcs, ['claim_atom', 'register_artifact', 'submit_atom'],
        'registered before it is submitted, so submit_atom can read its size');
    const submit = api.calls.find((c) => c[1] === 'submit_atom')[2];
    assert.equal(submit.atom_id, 42);
    assert.equal(submit.output_sha256, declared);
    assert.equal(typeof submit.result.gpu_seconds, 'number');
    assert.equal(loop.done, 1);
});

test('an artifact the store already holds is pointed at, not written again', async () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    const sha = await import('../lib/hash.js').then((m) => m.sha256(bytes));
    const api = fakeApi({}, { claim_atom: ATOM, submit_atom: 'verified' });
    api.select = async (table) => (table === 'artifact'
        ? [{ sha256: sha }]
        : [{ id: 9, result: { path: `/jobs/9/${sha}.json` } }]);
    const loop = new WorkLoop({
        api,
        filesUrl: 'http://files',
        spawn: () => ({ run: async () => OUT, terminate: () => {} }),
        // Invariant 1: can_write refuses a sha the artifact table already
        // knows; only the copy that is really there answers a HEAD, and it is
        // under the earlier atom, not under this one.
        fetchFn: async (url, opts) => {
            if (opts?.method !== 'HEAD') return new Response('', { status: 403 });
            return new Response('', { status: url.includes('/jobs/9/') ? 200 : 404 });
        },
        timers: { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => {} },
    });
    assert.equal(await loop.step(), 'verified');
    const submit = api.calls.find((c) => c[1] === 'submit_atom')[2];
    assert.equal(submit.output_sha256, sha);
    assert.equal(submit.result.path, `/jobs/9/${sha}.json`,
        'the consumer is told where the bytes really are');
});

test('nothing to claim is not a failure', async () => {
    const { loop } = loopOver(null, { spawnOut: OUT });
    assert.equal(await loop.step(), null);
    assert.equal(loop.done, 0);
    assert.equal(loop.failed, 0);
});

test('the claim is kept alive by a heartbeat, and only while it is held', async () => {
    let beat = null;
    let cleared = false;
    const api = fakeApi({ artifact: [] }, {
        claim_atom: ATOM, submit_atom: 'verified', register_artifact: SHA_A,
        heartbeat: null,
    });
    const loop = new WorkLoop({
        api,
        filesUrl: 'http://files',
        spawn: () => ({ run: async () => OUT, terminate: () => {} }),
        fetchFn: async () => new Response('', { status: 201 }),
        timers: {
            setInterval: (fn, ms) => { beat = { fn, ms }; return 'beat'; },
            clearInterval: (h) => { cleared = h === 'beat'; },
            setTimeout: () => {},
        },
    });
    await loop.step();
    assert.equal(beat.ms, 60_000, 'every 60 s, well inside the 5 minute expiry');
    await beat.fn();
    assert.deepEqual(api.calls.find((c) => c[1] === 'heartbeat')[2], { atom_id: 42 });
    assert.equal(cleared, true, 'and stopped once the atom is submitted');
});

test('a claim that fails is idle, logged once per streak, and not a crash', async () => {
    const logs = [];
    let fails = 0;
    const { loop } = loopOver(null, { spawnOut: OUT, rpcs: {
        claim_atom: () => { if (fails++ < 3) throw new Error('down'); return null; },
    } });
    loop.log = (rec) => logs.push(rec);
    for (let i = 0; i < 4; i++) assert.equal(await loop.step(), null);
    const failed = logs.filter((r) => r.event === 'claim-failed');
    assert.equal(failed.length, 1, 'one line for three consecutive failures');
    assert.match(failed[0].err, /down/);
    fails = 0;
    await loop.step();
    assert.equal(logs.filter((r) => r.event === 'claim-failed').length, 2,
        'a new streak after a success is logged again');
});

test('stop() then start() leaves one loop running, not two', async () => {
    let claims = 0;
    const wake = [];
    const { loop } = loopOver(null, { spawnOut: OUT, rpcs: {
        claim_atom: () => { claims++; return null; },
    } });
    loop.timers = { ...loop.timers, setTimeout: (fn) => wake.push(fn) };
    const parked = async (n) => {
        while (wake.length < n) await new Promise((r) => setTimeout(r, 0));
    };
    const first = loop.start();
    await parked(1);
    assert.equal(claims, 1, 'the first loop claimed and is now waiting');
    loop.stop();
    const second = loop.start();
    await parked(2);
    assert.equal(claims, 2, 'the second loop claimed');
    // Wake the first loop: superseded, it exits without claiming again.
    wake.shift()();
    await first;
    assert.equal(claims, 2, 'the superseded loop did not claim');
    assert.equal(loop.running, true, 'and the live one is still running');
    loop.stop();
    wake.shift()();
    await second;
});

test('an upload refused because its own bytes are already there is not a failure', async () => {
    // A sog atom uploads the tile's sog, height and colliders. If it fails
    // after the height is registered, the retry is refused (Invariant 1: the
    // sha is known) at exactly the path the bytes are already at — and the
    // height belongs to no atom's output_sha256, so nothing else names it.
    const bytes = new TextEncoder().encode('height');
    const sha = await import('../lib/hash.js').then((m) => m.sha256(bytes));
    const api = fakeApi({}, { claim_atom: ATOM });
    api.select = async (table) => (table === 'artifact' ? [{ sha256: sha }] : []);
    const asked = [];
    const loop = new WorkLoop({
        api,
        filesUrl: 'http://files',
        spawn: () => ({ run: async () => OUT, terminate: () => {} }),
        fetchFn: async (url, opts) => {
            asked.push([opts?.method ?? 'GET', url]);
            return new Response('', { status: opts?.method === 'HEAD' ? 200 : 403 });
        },
        timers: { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => {} },
    });
    const where = await loop.upload({ id: 3 }, { ext: 'r16', kind: 'height', bytes,
        dir: '/tiles/14/8550/5809' }, sha);
    assert.equal(where, `/tiles/14/8550/5809/${sha}.r16`);
    assert.deepEqual(asked.filter((a) => a[0] === 'HEAD').map((a) => a[1]),
        [`http://files/tiles/14/8550/5809/${sha}.r16`],
        'the path it asked for is the first one looked at');
});

test('an idle worker opens the jobs for tiles that are still waiting', async () => {
    // claim_atom stops offering a job the tile has moved past (db/0052), and
    // publishing a child moves its parent past its job. Without this the pool
    // goes quiet with every ancestor waiting for a button nobody will press.
    const opened = [];
    const api = fakeApi({}, {
        claim_atom: null,
        my_dirty_tiles: [
            { z: 12, x: 2137, y: 1452, job_id: null },
            { z: 10, x: 534, y: 363, job_id: 7 },
            { z: 8, x: 133, y: 90, job_id: null },
        ],
        ensure_job: 99,
    });
    const loop = new WorkLoop({
        api,
        filesUrl: 'http://files',
        spawn: () => ({ run: async () => OUT, terminate: () => {} }),
        fetchFn: async () => new Response('', { status: 201 }),
        timers: { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => {} },
    });
    assert.equal(await loop.step(), null, 'nothing to claim');
    await loop.reopen();
    for (const call of api.calls) {
        if (call[1] === 'ensure_job') opened.push(`${call[2].z}/${call[2].x}/${call[2].y}`);
    }
    assert.deepEqual(opened, ['12/2137/1452', '8/133/90'],
        'a job is opened for each waiting tile that has none, and no other');
});

test('a tile the player may not open is not an error', async () => {
    const api = fakeApi({}, { claim_atom: null,
        my_dirty_tiles: [{ z: 6, x: 33, y: 22, job_id: null }] });
    api.rpc = async (name, args) => {
        api.calls.push(['rpc', name, args]);
        if (name === 'ensure_job') throw new Error('not authorised for 6/33/22');
        if (name === 'my_dirty_tiles') return [{ z: 6, x: 33, y: 22, job_id: null }];
        return null;
    };
    const loop = new WorkLoop({
        api,
        filesUrl: 'http://files',
        spawn: () => ({ run: async () => OUT, terminate: () => {} }),
        fetchFn: async () => new Response('', { status: 201 }),
        timers: { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => {} },
    });
    await loop.reopen();
    assert.equal(loop.failed, 0, 'a refusal is not a failed atom');
});
