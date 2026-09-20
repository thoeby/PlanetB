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

test('an atom of a version this tab does not build is failed back, not run', async () => {
    const { loop, api } = loopOver({ ...ATOM, op: 'train', algo_version: 'train-v1' });
    await assert.rejects(() => loop.step(), /train-v1/);
    const failed = api.calls.find((c) => c[0] === 'rpc' && c[1] === 'fail_atom');
    assert.ok(failed, 'it went back to the pool');
    assert.match(failed[2].reason, /train-v1/);
});

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

// db/0173: the world takes a claim back when nobody beats for it, and a tab
// that finds out at submit_atom has already spent the hour. A refused beat is
// the answer, and it stops the run.
test('a claim the world has taken back stops the run at the next beat', async () => {
    let beat = () => {};
    const api = fakeApi({ artifact: [] }, {
        claim_atom: ATOM,
        heartbeat: () => { throw new Error('atom 42 is not claimed by you'); },
        submit_atom: 'verified',
    });
    const loop = new WorkLoop({
        api,
        filesUrl: 'http://files',
        // The atom never finishes on its own: what ends this run is the beat.
        spawn: () => ({ run: () => new Promise(() => {}), terminate: () => {} }),
        fetchFn: async () => new Response('', { status: 201 }),
        timers: { setInterval: (fn) => { beat = fn; return 1; },
            clearInterval: () => {}, setTimeout: () => {} },
    });
    const running = loop.step();
    // Let the claim and the input resolution settle, then miss a beat.
    await new Promise((r) => { setTimeout(r, 0); });
    beat();
    await assert.rejects(() => running, /took this piece back/);
    assert.ok(api.calls.some((c) => c[1] === 'fail_atom'),
        'and the piece is handed back with the reason on it');
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
    assert.equal(beat.ms, 30_000,
        'every 30 s, so a lease an operator has turned down still holds');
    await beat.fn();
    assert.deepEqual(api.calls.find((c) => c[1] === 'heartbeat')[2], { atom_id: 42 });
    assert.equal(cleared, true, 'and stopped once the atom is submitted');
});

test('a piece the tab cannot do is failed back into the pool at once', async () => {
    const { loop, api } = loopOver(ATOM, { rpcs: { fail_atom: 'ready' } });
    loop.spawn = () => ({
        run: async () => { throw new Error('no ground at 14/1/1'); },
        terminate: () => {},
    });
    const logs = [];
    loop.log = (rec) => logs.push(rec);
    await assert.rejects(loop.step(), /no ground/);
    const fail = api.calls.find((c) => c[1] === 'fail_atom');
    assert.ok(fail, 'fail_atom is called');
    assert.equal(fail[2].atom_id, 42);
    assert.match(fail[2].reason, /no ground/);
    assert.equal(loop.failed, 1);
    assert.equal(loop.atom, null, 'and the tab holds nothing');
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

// db/0143 and the Work cards: a tab keeps the frames it traced as well as the
// splats it fitted, and a frame record names no tile of its own.
test('the loop keeps a picture of each kind of the tile it is working on', async () => {
    const { loop } = loopOver(ATOM, { spawnOut: OUT });
    loop.log({ event: 'assembled', tile: { z: 14, x: 3, y: 4 } });
    loop.log({ event: 'frame', done: 1, of: 3, picture: { webp: new Uint8Array([1]) } });
    loop.log({ event: 'train', iter: 20, of: 60, picture: { rgba: new Uint8Array(4) } });
    const both = loop.shots.get('14/3/4');
    assert.equal(both.frame.done, 1, 'the frame picture survived the training');
    assert.equal(both.splat.iter, 20);
});
