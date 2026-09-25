// A stored file asked for by CID, and the protocol one peer answers on (LV.12).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { peerFetch, storedSha, tileFile } from '../js/peerfetch.js';
import { ask, serve } from '../lib/fetchproto.js';

const SHA = 'a'.repeat(64);

test('only stored files, named by their sha256, are asked of peers', () => {
    assert.deepEqual(storedSha(`http://w/assets/${SHA}.glb`), { sha: SHA, ext: 'glb' });
    assert.deepEqual(storedSha(`http://w/tiles/14/1/2/${SHA}.sog`), { sha: SHA, ext: 'sog' });
    assert.equal(storedSha('http://w/app/play.html'), null);
    assert.equal(storedSha(`http://w/jobs/${SHA}.json`), null);
});

test('a file with no CID, or no peers at all, goes to the store as it was', async () => {
    const asked = [];
    const fallback = async (url) => { asked.push(url); return new Response('store'); };
    const url = `http://w/assets/${SHA}.glb`;
    assert.equal(await (await peerFetch(null, fallback)(url)).text(), 'store');
    const noCid = { h: {}, cidOf: async () => null, get: async () => assert.fail('asked') };
    assert.equal(await (await peerFetch(noCid, fallback)(url)).text(), 'store');
    const peers = { h: {}, cidOf: async () => 'bafkx',
        get: async () => new TextEncoder().encode('peer') };
    assert.equal(await (await peerFetch(peers, fallback)(url)).text(), 'peer');
    assert.equal(await (await peerFetch(peers, fallback)(url, { method: 'PUT' })).text(), 'store');
    assert.equal(asked.length, 3);
});

test('a tile with levels is handed over as blob URLs, each named in its fragment', async () => {
    const files = { 'http://w/tiles/9/1/1/m.json': JSON.stringify({ filenames: ['l0.sog', 'l1.sog'] }),
        'http://w/tiles/9/1/1/l0.sog': 'zero', 'http://w/tiles/9/1/1/l1.sog': 'one' };
    const fetchFn = async (url) => new Response(files[url], { status: files[url] ? 200 : 404 });
    const file = await tileFile(fetchFn, { url: 'http://w/tiles/9/1/1/m.json',
        filename: 'lod-meta.json' });
    assert.equal(file.filename, 'lod-meta.json');
    const meta = await (await fetch(file.url)).json();
    assert.match(meta.filenames[0], /^blob:.*#\/l0\.sog$/);
    assert.equal(await (await fetch(meta.filenames[1])).text(), 'one');
});

// Two ends of one stream, as libp2p hands them over.
function pipe() {
    const make = () => ({ inbox: [], waiting: null, closed: false });
    const a = make(), b = make();
    const end = (me, other) => ({
        send(bytes) { other.inbox.push(bytes); other.waiting?.(); return true; },
        async onDrain() {},
        async close() { other.closed = true; other.waiting?.(); },
        async *[Symbol.asyncIterator]() {
            for (;;) {
                if (me.inbox.length) { yield me.inbox.shift(); continue; }
                if (me.closed) return;
                await new Promise((r) => { me.waiting = r; });
                me.waiting = null;
            }
        },
    });
    return [end(a, b), end(b, a)];
}

test('one peer is asked for one CID and answers the whole file, or nothing', async () => {
    const file = new Uint8Array(200_000).map((_, i) => i % 251);
    const [asker, server] = pipe();
    const [got, sent] = await Promise.all([ask(asker, 'bafkone'),
        serve(server, async (cid) => (cid === 'bafkone' ? file : null))]);
    assert.equal(sent, file.length);
    assert.deepEqual(got, file);
    const [asker2, server2] = pipe();
    const [none] = await Promise.all([ask(asker2, 'bafktwo'), serve(server2, async () => null)]);
    assert.equal(none.length, 0);
});
