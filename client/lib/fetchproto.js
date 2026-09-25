// fetchproto.js — `/splatworld/fetch/1`: asking one named peer for one file.
//
// TASKS-live.md LV.12. Helia's own exchange asks everybody at once and does
// not say who answered, so a peer that serves wrong bytes could not be told
// apart from one that serves the right ones. This protocol asks one peer by
// name: the request is the file's CID as text and a newline, the answer is the
// whole file and the end of the stream. The asker hashes what arrives
// (client/js/peers.js) and knows exactly whom to drop.
//
// The operator's node (tools/node.mjs) and every tab speak it. Pure: the
// stream is libp2p's (async iterable of chunks, `send`, `close`), nothing else.

export const PROTOCOL = '/splatworld/fetch/1';
const NEWLINE = 10;
const MAX_ASK = 256;

const bytesOf = (chunk) => (chunk instanceof Uint8Array ? chunk : chunk.subarray());

async function sendAll(stream, bytes) {
    const STEP = 65536;
    for (let at = 0; at < bytes.length; at += STEP) {
        if (!stream.send(bytes.subarray(at, at + STEP))) await stream.onDrain();
    }
}

// Serving: read the CID, look the file up, send it, close. `lookup(cid)`
// resolves to the bytes or null; nothing found is an empty answer.
export async function serve(stream, lookup) {
    let asked = '';
    for await (const chunk of stream) {
        const b = bytesOf(chunk);
        const end = b.indexOf(NEWLINE);
        asked += new TextDecoder().decode(end < 0 ? b : b.subarray(0, end));
        if (end >= 0 || asked.length > MAX_ASK) break;
    }
    const bytes = asked.length <= MAX_ASK ? await lookup(asked.trim()).catch(() => null) : null;
    if (bytes) await sendAll(stream, bytes);
    await stream.close();
    return bytes?.length ?? 0;
}

// Asking: one CID, the whole answer. An empty answer is "I have not got it".
export async function ask(stream, cid, { limit = 512 * 1024 * 1024 } = {}) {
    stream.send(new TextEncoder().encode(`${cid}\n`));
    const parts = [];
    let size = 0;
    for await (const chunk of stream) {
        const b = bytesOf(chunk);
        size += b.length;
        if (size > limit) throw new Error('the answer is bigger than any file the world holds');
        parts.push(b.slice());
    }
    await stream.close().catch(() => {});
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}
