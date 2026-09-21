// workstore.test.js — db/0180: a registered artifact the store has lost is
// forgotten and written again by the tab that has the bytes in hand; an
// input that 404s puts the atom that made it back in the pool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkLoop } from '../js/work.js';
import { sha256 } from '../lib/hash.js';

const SHA_A = 'a'.repeat(64);
const ATOM = {
    id: 42, job_id: 9, op: 'noop', algo_version: 'noop-v1', atom_hash: SHA_A,
    inputs: {}, params: {}, seed: 0, state: 'claimed',
};
const TIMERS = { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => {} };

function fakeApi(rows = {}, rpcs = {}) {
    const calls = [];
    return {
        calls,
        token: () => 'jwt',
        select: async (table) => { calls.push(['select', table]); return rows[table] ?? []; },
        rpc: async (name, args) => { calls.push(['rpc', name, args]); return rpcs[name]; },
    };
}

test('a registered artifact nowhere in the store is forgotten and put back', async () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    const sha = await sha256(bytes);
    const api = fakeApi({ artifact: [{ sha256: sha }] },
        { artifact_missing: 1, register_artifact: sha });
    let puts = 0;
    let forgotten = false;
    const loop = new WorkLoop({
        api, filesUrl: 'http://files', timers: TIMERS,
        fetchFn: async (url, opts) => {
            if (opts?.method === 'HEAD') return new Response('', { status: 404 });
            puts += 1;
            return new Response('', { status: forgotten ? 201 : 403 });
        },
    });
    const rpc = api.rpc;
    api.rpc = async (name, args) => {
        if (name === 'artifact_missing') forgotten = true;
        return rpc(name, args);
    };
    const where = await loop.upload({ id: 3, op: 'noop' },
        { ext: 'json', kind: 'ply', bytes }, sha);
    assert.equal(where, `/jobs/3/${sha}.json`);
    assert.equal(puts, 2, 'refused once, written the second time');
    assert.ok(api.calls.some((c) => c[1] === 'artifact_missing' && c[2].sha256 === sha));
});

test('an input the store has lost puts its maker back in the pool and says so', async () => {
    const sha = 'ab'.repeat(32);
    const api = fakeApi(
        { atom: [{ id: 7, output_sha256: sha, result: { path: `/jobs/7/${sha}.ply` } }] },
        { claim_atom: { ...ATOM, inputs: { assemble: 7 } }, artifact_missing: 1,
            fail_atom: 'ready' });
    const loop = new WorkLoop({ api, filesUrl: 'http://files', timers: TIMERS,
        spawn: () => ({ run: async () => null, terminate: () => {} }) });
    loop.cache.load = async () => {
        throw new Error(`GET http://files/jobs/7/${sha}.ply -> 404`);
    };
    await assert.rejects(() => loop.step(),
        /gone from the store, so the 1 piece\(s\) that made it/);
    assert.ok(api.calls.some((c) => c[1] === 'artifact_missing' && c[2].sha256 === sha));
});
