// api.js without a server: paging, and the atoms' bare fetch. The global
// fetch is stood in for and put back.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, configure, fetchJson, selectAll } from '../js/api.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
});

async function withFetch(fn, body) {
    const real = globalThis.fetch;
    globalThis.fetch = fn;
    try { return await body(); } finally { globalThis.fetch = real; }
}

test('selectAll pages until a page comes back short', async () => {
    configure({ api: 'http://api' });
    const urls = [];
    const rows = await withFetch(async (url) => {
        urls.push(url);
        const offset = Number(new URL(url).searchParams.get('offset'));
        const n = offset === 0 ? 3 : (offset === 3 ? 3 : 1);
        return json(Array.from({ length: n }, (_, i) => ({ id: offset + i })));
    }, () => selectAll('tile', { order: 'id' }, 3));
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.map((r) => r.id), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(urls.length, 3, 'three pages: full, full, short');
    assert.match(urls[1], /order=id/);
    assert.match(urls[1], /offset=3/);
    assert.match(urls[1], /limit=3/);
});

test('fetchJson throws on a status that is not ok, naming it and the url', async () => {
    await withFetch(async () => json({ message: 'nope' }, 503), async () => {
        await assert.rejects(() => fetchJson('http://api/rpc/x'), (err) => {
            assert.ok(err instanceof ApiError);
            assert.equal(err.status, 503);
            assert.match(err.message, /503 http:\/\/api\/rpc\/x: nope/);
            return true;
        });
    });
    const body = await withFetch(async () => json([{ a: 1 }]), () => fetchJson('http://api/t'));
    assert.deepEqual(body, [{ a: 1 }]);
});
