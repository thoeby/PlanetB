// peers.js — every tab is a peer (TASKS-live.md LV.12).
//
// A tab runs a libp2p node of its own (Helia's, vendored in
// client/vendor/helia), reached through the operator's relay
// (tools/node.mjs). What it fetches it keeps in the browser's block store and
// serves, while it is open, to any tab that asks. A file is asked for by its
// CID, in this order:
//
//   this tab's own store  ->  the tabs that say they hold it (db/0213)
//   ->  the operator's node over libp2p  ->  GET /ipfs/{cid}, last
//
// and whoever answers, the bytes are hashed on arrival: the sha256 is the
// file's identity (Invariant 1). A tab that sent wrong bytes is dropped for
// the session and the page says so. Every ask is one named peer
// (client/lib/fetchproto.js), so "who sent that" always has an answer.

import * as api from './api.js';
import { sha256 } from '../lib/hash.js';
import { PROTOCOL, ask, serve } from '../lib/fetchproto.js';

const VENDOR = '../vendor/helia/helia.js';
const ASK_MS = 15_000;
const SAY_EVERY_MS = 30_000;

// The world's settings (server/splatworld/cid.py, tools/node.mjs).
const settings = (h) => ({ cidVersion: 1, rawLeaves: true, reduceSingleLeafToSelf: true,
    chunker: h.fixedSize({ chunkSize: 262144 }), layout: h.balanced({ maxChildrenPerNode: 174 }) });

async function importInto(h, store, bytes) {
    let last = null;
    for await (const e of h.importer([{ content: bytes }], store, settings(h))) last = e;
    return last.cid.toString();
}

async function exportFrom(h, store, cid) {
    const entry = await h.exporter(h.CID.parse(cid), store);
    const parts = [];
    for await (const c of entry.content()) parts.push(c);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}

const within = (ms, promise) => Promise.race([promise, new Promise((_, no) =>
    setTimeout(() => no(new Error('no answer')), ms))]);

export class Peers {
    constructor({ filesUrl = '', say = () => {}, where = () => null } = {}) {
        this.filesUrl = filesUrl;
        this.say = say;
        this.where = where;
        this.dropped = new Set();     // peer ids that sent wrong bytes, this session
        this.held = new Set();        // CIDs this tab has, and serves
        this.from = new Map();        // CID -> who it came from: here, a player, node, http
        this.cids = new Map();        // sha256 -> CID
        this.served = [];             // what this tab sent, and to whom
        this.unsaid = [];             // got from a host before anybody signed in
        this.node = null;
    }

    get id() { return this.libp2p?.peerId.toString() ?? null; }

    async start() {
        if (this.starting) return this.starting;
        this.starting = this.boot().catch((err) => {
            console.warn(`peers: this tab is not a peer (${err.message}); files come by HTTP`);
            this.h = null;
            this.libp2p?.stop().catch(() => {});
            this.libp2p = null;
            return false;
        });
        return this.starting;
    }

    async boot() {
        const h = await import(VENDOR);
        this.store = new h.IDBBlockstore('splatworld-blocks');
        await this.store.open().catch(() => { this.store = new h.MemoryBlockstore(); });
        const info = await (await fetch(`${this.filesUrl}/node/peer`)).json();
        this.node = info;
        this.libp2p = await h.createLibp2p({
            addresses: { listen: ['/p2p-circuit', '/webrtc'] },
            transports: [h.webSockets(), h.webRTC(), h.circuitRelayTransport()],
            connectionEncrypters: [h.noise()], streamMuxers: [h.yamux()],
            // A world on one machine is all private addresses; the page asks
            // for the ones the world listed, and nothing else.
            connectionGater: { denyDialMultiaddr: () => false },
            services: { identify: h.identify() },
        });
        this.h = h;
        await this.libp2p.handle(PROTOCOL, (stream, conn) => this.answer(stream, conn),
            { runOnLimitedConnection: true });
        const ws = info.addrs.find((a) => a.includes('/ws/'));
        await this.libp2p.dial(h.multiaddr(ws));
        await within(ASK_MS, this.relayed());
        this.timer = setInterval(() => this.tell(), SAY_EVERY_MS);
        globalThis.addEventListener?.('pagehide', () => this.leave());
        await this.tell();
        return true;
    }

    // Wait until the relay gave this tab an address other tabs can dial.
    async relayed() {
        while (!this.addrs().length) await new Promise((r) => setTimeout(r, 200));
    }

    addrs() {
        // Through the relay first; the WebRTC upgrade of it when that fails.
        const all = (this.libp2p?.getMultiaddrs() ?? []).map(String)
            .filter((a) => a.includes('/p2p-circuit'));
        return [...all.filter((a) => !a.includes('/webrtc')),
            ...all.filter((a) => a.includes('/webrtc'))];
    }

    // What this tab holds, and where it can be dialled, told to the world.
    async tell() {
        if (!this.libp2p) return;
        const at = this.where() ?? {};
        await api.rpc('register_peer', { peer_id: this.id, addrs: this.addrs(),
            cids: [...this.held], lon: at.lon ?? null, lat: at.lat ?? null }).catch(() => {});
    }

    leave() {
        if (!this.id) return;
        api.rpcOnTheWayOut('unregister_peer', { peer_id: this.id });
    }

    async local(cid) {
        if (!this.h || !(await this.store.has(this.h.CID.parse(cid)).catch(() => false))) {
            return null;
        }
        return exportFrom(this.h, this.store, cid);
    }

    async answer(stream, conn) {
        const sent = await serve(stream, (cid) => this.local(cid)).catch(() => 0);
        if (sent) this.served.push({ to: conn.remotePeer.toString(), bytes: sent, at: Date.now() });
    }

    // Bytes that are the file, or null — and the peer dropped if they are not.
    async checked(bytes, sha, who, what) {
        if (!bytes?.length) return null;
        if (await sha256(bytes) === sha) return bytes;
        if (who.peer) {
            this.dropped.add(who.peer);
            this.say(`${who.name}’s tab sent bytes that are not ${what}; it is skipped`
                + ' for the rest of this visit.', true);
        }
        return null;
    }

    async fromPeers(cid, sha, what) {
        const list = await api.rpc('peers_for', { cid, not_peer: this.id }).catch(() => []);
        for (const p of list ?? []) {
            if (this.dropped.has(p.peer_id)) continue;
            for (const addr of p.addrs ?? []) {
                const bytes = await within(ASK_MS, this.askAt(addr, cid)).catch(() => null);
                const good = await this.checked(bytes, sha,
                    { peer: p.peer_id, name: p.player }, what);
                if (good) {
                    // LV.13: a tab hosting this file for a term is paid for
                    // serving it; this tab says it got it, under its login,
                    // before it goes on (a tab closed a moment later still said).
                    await this.receipt(p.peer_id, cid);
                    return { bytes: good, from: p.player };
                }
                if (this.dropped.has(p.peer_id)) break;
            }
        }
        return null;
    }

    // A receipt is the reader's, under its login. Bytes that came before
    // anybody signed in — the world streams in while the sign-in form is
    // still open — are said once somebody does (`signedIn`).
    async receipt(peer, cid) {
        if (!api.claims()) { this.unsaid.push({ peer, cid }); return; }
        await api.rpc('host_served', { peer, cid }).catch(() => {});
    }

    async signedIn() {
        for (const r of this.unsaid.splice(0)) await this.receipt(r.peer, r.cid);
    }

    async askAt(addr, cid) {
        const stream = await this.libp2p.dialProtocol(this.h.multiaddr(addr), PROTOCOL,
            { runOnLimitedConnection: true });
        return ask(stream, cid);
    }

    // One file, by CID, from whoever has it; checked against its sha256.
    async get(cid, sha, what = 'the file') {
        const here = await this.local(cid).catch(() => null);
        if (await this.checked(here, sha, {}, what)) return this.keep(cid, here, 'here', false);
        if (this.h) {
            const peer = await this.fromPeers(cid, sha, what);
            if (peer) return this.keep(cid, peer.bytes, peer.from);
            const addr = this.node?.addrs?.find((a) => a.includes('/ws/'));
            const bytes = addr ? await within(ASK_MS, this.askAt(addr, cid)).catch(() => null)
                : null;
            if (await this.checked(bytes, sha, {}, what)) return this.keep(cid, bytes, 'node');
        }
        const res = await fetch(`${this.filesUrl}/ipfs/${cid}`).catch(() => null);
        const bytes = res?.ok ? new Uint8Array(await res.arrayBuffer()) : null;
        if (await this.checked(bytes, sha, {}, what)) return this.keep(cid, bytes, 'http');
        throw new Error(`nobody has ${what}: not a tab, not the world's node`);
    }

    async keep(cid, bytes, from, store = true) {
        this.from.set(cid, from);
        if (store && this.h) await importInto(this.h, this.store, bytes).catch(() => {});
        if (this.h && !this.held.has(cid)) {
            this.held.add(cid);
            clearTimeout(this.soon);
            this.soon = setTimeout(() => this.tell(), 500);
        }
        return bytes;
    }

    // A file known by its sha256 (what the world's rows name) — by CID when
    // the world has recorded one, else by the path it was stored at.
    async bySha(sha, path, what) {
        const cid = await this.cidOf(sha);
        if (cid) return this.get(cid, sha, what);
        const res = await fetch(`${this.filesUrl}${path}`);
        if (!res.ok) throw new Error(`${path} -> ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
    }

    async cidOf(sha) {
        if (!this.cids.has(sha)) {
            this.cids.set(sha, await api.rpc('cid_of', { sha256: sha }).catch(() => null));
        }
        return this.cids.get(sha);
    }
}
