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
function loopOver(atom, { rpcs = {}, spawnOut, lanes = 1 } = {}) {
    const puts = [];
    const api = fakeApi({ artifact: [] }, {
        claim_atom: atom, submit_atom: 'verified', register_artifact: SHA_A, ...rpcs,
    });
    const loop = new WorkLoop({
        api,
        lanes,
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

test('an atom of a version this tab does not build is handed back, not failed', async () => {
    const { loop, api } = loopOver({ ...ATOM, op: 'train', algo_version: 'train-v1' });
    await assert.rejects(() => loop.step(), /train-v1.*job is out of date/);
    const back = api.calls.find((c) => c[0] === 'rpc' && c[1] === 'hand_back_atom');
    assert.ok(back, 'it went back to the pool');
    assert.ok(!api.calls.some((c) => c[1] === 'fail_atom'), 'refusing is not an attempt');
});

test('an atom newer than this tab says the page is out of date', async () => {
    const { loop } = loopOver({ ...ATOM, op: 'train', algo_version: 'train-v99' });
    await assert.rejects(() => loop.step(), /train-v99: this page is out of date, reload it/);
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

// One lane here, so the count is about generations and not about how many
// pieces a tab takes at once — which the test below is about.
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

// A tile's frames are independent of one another, and a tab did them one at a
// time: the network idle while the GPU worked, the GPU idle while it uploaded.
// Four lanes overlap them.
test('a tab takes four pieces at once, not one', async () => {
    let handed = 0;
    const inFlight = [];
    let most = 0;
    const done = [];
    const { loop } = loopOver(null, { lanes: 4, spawnOut: OUT, rpcs: {
        claim_atom: () => (handed < 8 ? { ...ATOM, id: ++handed } : null),
    } });
    // Each atom is held until the test lets it go, so how many are in hand at
    // once is a thing the test can read rather than a race it has to win.
    loop.spawn = () => ({
        run: () => new Promise((go) => { inFlight.push(go); most = Math.max(most,
            inFlight.length); }),
        terminate: () => {},
    });
    loop.timers = { ...loop.timers, setTimeout: () => {} };
    const runs = Array.from({ length: 4 }, () => loop.step().then((s) => done.push(s)));
    while (inFlight.length < 4) await new Promise((r) => setTimeout(r, 0));
    assert.equal(loop.working.size, 4, 'four atoms are in hand');
    assert.ok(loop.atom, 'and one of them is the one the panels read');
    for (const go of inFlight.splice(0)) go(OUT);
    await Promise.all(runs);
    assert.equal(most, 4);
    assert.deepEqual(done, ['verified', 'verified', 'verified', 'verified']);
    assert.equal(loop.working.size, 0, 'and none is left in hand');
    assert.equal(loop.atom, null);
});

// SPEC §3.12: a tab that is closing hands back what it is holding, so nobody
// waits five minutes for work that is in nobody's hands. All of it, now that
// there is more than one piece.
test('closing the tab hands back every piece it is holding', async () => {
    const { loop, api } = loopOver(null, { lanes: 4 });
    const back = [];
    api.rpcOnTheWayOut = (name, args) => back.push([name, args.atom_id]);
    loop.api = api;
    for (const id of [11, 12, 13]) loop.working.set(id, { id });
    loop.atom = loop.working.get(11);
    assert.equal(loop.handBack(), 3);
    assert.deepEqual(back, [['hand_back_atom', 11], ['hand_back_atom', 12],
        ['hand_back_atom', 13]]);
    assert.equal(loop.handBack(), false, 'and nothing is handed back twice');
});


// db/0181: a claim this tab lost is not this tab's to put down, and the run
// it lost is stopped rather than left training for nobody.
test('a lost claim stops the run and fails nothing', async () => {
    let beat = null;
    let terminated = 0;
    const api = fakeApi({ artifact: [] }, {
        claim_atom: { ...ATOM, op: 'train', algo_version: 'train-v22' },
        heartbeat: () => {
            throw new Error('atom 42 is not claimed by you: another tab holds it');
        },
    });
    const loop = new WorkLoop({
        api, filesUrl: 'http://files',
        spawn: () => ({ run: () => new Promise(() => {}), terminate: () => { terminated += 1; } }),
        timers: { setInterval: (fn) => { beat = fn; return 1; }, clearInterval: () => {},
            setTimeout: () => {} },
    });
    const stepping = loop.step();
    await new Promise((r) => setTimeout(r, 5));
    beat();
    await assert.rejects(() => stepping, /took this piece back/);
    assert.equal(terminated, 1, 'the worker is stopped');
    assert.ok(!api.calls.some((c) => c[1] === 'fail_atom'), 'nothing is failed');
});
