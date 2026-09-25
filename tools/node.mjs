#!/usr/bin/env node
// node.mjs — the operator's IPFS node: the file store's other half (LV.11).
//
// Every file the world holds is also here, as IPFS blocks under
// infra/files/blocks, so the players' tabs can find it by CID among each other
// (LV.12) and fall back to this node when no tab has it. Tabs cannot pin for
// good or find each other without a relay, so this one node does both:
//
//   libp2p   WebSockets and WebRTC-direct for tabs to dial, a circuit relay
//            so tabs reach each other through it, and `/splatworld/fetch/1`
//            (client/lib/fetchproto.js) to answer a tab that asks for a file.
//            WebTransport is not listened on: js-libp2p has no WebTransport
//            listener in node; tabs dial the two it has.
//   files    every file under FILES_ROOT/{assets,tiles} is added with the
//            world's fixed settings and its CID recorded: what is there when it
//            starts, then what the store writes (tools/nodewatch.mjs)
//   HTTP     POST /add     the same for a file handed to it directly (server/
//                          does, after can_write, Invariant 6)
//            GET /ipfs/{cid}   the file, for a tab that no peer answered
//            GET /peer     this node's id and addresses, for tabs to dial
//            GET /healthz
//
// It computes nothing about the world; it holds and hands out bytes the world
// already said exist. The CID it records is the one server/splatworld/cid.py
// derives without it (tools/files-test.sh holds the two together).
//
//   FILES_ROOT=infra/files API_URL=… JWT_SECRET=… node tools/node.mjs

import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';
import { FsBlockstore } from 'blockstore-fs';
import { FsDatastore } from 'datastore-fs';
import { webSockets } from '@libp2p/websockets';
import { webRTCDirect } from '@libp2p/webrtc';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';
import { CID } from 'multiformats/cid';

import { PROTOCOL, serve } from '../client/lib/fetchproto.js';
import { watchStore } from './nodewatch.mjs';

// The world's settings, once (server/splatworld/cid.py says them again).
export const IMPORT = {
    cidVersion: 1, rawLeaves: true, reduceSingleLeafToSelf: true,
    chunker: fixedSize({ chunkSize: 262144 }), layout: balanced({ maxChildrenPerNode: 174 }),
};

const env = process.env;
const CFG = {
    root: env.FILES_ROOT ?? 'infra/files',
    http: Number(env.NODE_HTTP_PORT ?? 8095),
    ws: Number(env.NODE_WS_PORT ?? 8096),
    rtc: Number(env.NODE_RTC_PORT ?? 8097),
    host: env.NODE_HOST ?? '127.0.0.1',
    api: (env.API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, ''),
    secret: env.JWT_SECRET ?? '',
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// The node records a CID as the file store: an admin key of its own, signed
// with the world's secret, good for a minute (db/0212 record_cid).
function adminKey() {
    const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({ role: 'admin', sub: null,
        exp: Math.floor(Date.now() / 1000) + 60 }));
    return `${head}.${body}.${b64url(createHmac('sha256', CFG.secret)
        .update(`${head}.${body}`).digest())}`;
}

async function record(sha256, cid) {
    if (!CFG.secret) return 'no JWT_SECRET: not recorded';
    const res = await fetch(`${CFG.api}/rpc/record_cid`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminKey()}` },
        body: JSON.stringify({ sha256, cid }) })
        .catch((e) => ({ ok: false, text: () => e.message }));
    return res.ok ? null : await res.text();
}

async function start() {
    mkdirSync(join(CFG.root, 'blocks'), { recursive: true });
    const helia = await createHelia({
        blockstore: new FsBlockstore(join(CFG.root, 'blocks')),
        datastore: new FsDatastore(join(CFG.root, 'blocks', '.datastore')),
        libp2p: {
            addresses: { listen: [`/ip4/${CFG.host}/tcp/${CFG.ws}/ws`,
                `/ip4/${CFG.host}/udp/${CFG.rtc}/webrtc-direct`] },
            transports: [webSockets(), webRTCDirect()],
            connectionEncrypters: [noise()], streamMuxers: [yamux()],
            services: { identify: identify(),
                // A file between two tabs goes through the relay whole: no cap.
                relay: circuitRelayServer({ reservations: { maxReservations: 1024,
                    applyDefaultLimit: false } }) },
        },
    });
    await helia.start();
    const fs = unixfs(helia);
    const cat = async (text) => {
        const parts = [];
        for await (const c of fs.cat(CID.parse(text), { offline: true })) parts.push(c);
        return Buffer.concat(parts);
    };
    await helia.libp2p.handle(PROTOCOL, (stream) => { serve(stream, cat).catch(() => {}); });
    return { helia, fs, cat };
}

const TYPES = { glb: 'model/gltf-binary', elx: 'application/xml', json: 'application/json',
    png: 'image/png', webp: 'image/webp', tar: 'application/x-tar' };
const typeOf = (name) => TYPES[/\.([a-z0-9]+)$/.exec(name ?? '')?.[1]]
    ?? 'application/octet-stream';

const readBody = (req) => new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
});

function send(res, status, body, type = 'application/json') {
    res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*',
        ...(status === 200 && type !== 'application/json'
            ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {}) });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function keep(node, bytes, sha256) {
    const cid = (await node.fs.addBytes(bytes, IMPORT)).toString();
    return { cid, refused: await record(sha256, cid) };
}

async function add(node, req, res) {
    const bytes = await readBody(req);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const said = req.headers['x-sha256'];
    if (said && said !== sha256) return send(res, 400, { error: 'the bytes are not that sha256' });
    const { cid, refused } = await keep(node, bytes, sha256);
    return send(res, 200, { sha256, cid, recorded: !refused, said: refused ?? '' });
}

export async function main() {
    const node = await start();
    // Every file the store holds, the ones before this node was as well.
    const store = watchStore(CFG.root, async (bytes, sha) => (await keep(node, bytes, sha)).refused,
        (line) => process.stdout.write(`node: ${line}\n`));
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://node');
        try {
            if (req.method === 'POST' && url.pathname === '/add') return await add(node, req, res);
            const m = /^\/ipfs\/(b[a-z2-7]+)$/.exec(url.pathname);
            // LV.14: the old paths send a GET here with the name it was asked
            // by, so an ELX is still XML and a model still a model.
            if ((req.method === 'GET' || req.method === 'HEAD') && m) {
                return send(res, 200, await node.cat(m[1]),
                    typeOf(url.searchParams.get('filename')));
            }
            if (url.pathname === '/peer') {
                return send(res, 200, { id: node.helia.libp2p.peerId.toString(),
                    addrs: node.helia.libp2p.getMultiaddrs().map(String) });
            }
            if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
            return send(res, 404, { error: 'not here' });
        } catch (err) {
            return send(res, /not found|NotFound/i.test(String(err)) ? 404 : 500,
                { error: String(err.message ?? err) });
        }
    });
    server.listen(CFG.http, CFG.host, () => {
        process.stdout.write(`node: ${node.helia.libp2p.peerId} · http ${CFG.host}:${CFG.http}`
            + ` · ${node.helia.libp2p.getMultiaddrs().map(String).join(' ')}\n`);
    });
    const stop = async () => {
        store.close();
        server.close();
        await node.helia.stop();
        process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

if (process.argv[1]?.endsWith('node.mjs')) main();
