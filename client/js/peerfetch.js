// peerfetch.js — every stored file this tab reads, through its peers (LV.12).
//
// The page names files the way the world's rows do: a sha256, under the path
// it was stored at. `peerFetch` takes such a request and asks the peers for
// the file by its CID (client/js/peers.js), hashing what comes back, with
// /ipfs/{cid} last. Only a file the world has no CID for yet goes to the path
// it was stored at. A tile is loaded by the engine from a URL, so its bytes
// are handed over as a blob URL (`tileFile`), levels and all.

const STORED = /\/(?:tiles\/\d+\/\d+\/\d+|assets)\/([0-9a-f]{64})\.([a-z0-9]+)$/;

// Where a tile's stored files were PUT. A read of one goes through
// `peerFetch`, by its CID — this is the one place the path is spelt (LV.14).
export const tileDir = (filesUrl, z, x, y) => `${filesUrl}/tiles/${z}/${x}/${y}`;

export function storedSha(url) {
    const m = STORED.exec(new URL(url, globalThis.location?.href ?? 'http://x/').pathname);
    return m ? { sha: m[1], ext: m[2] } : null;
}

export function peerFetch(peers, fallback = (...a) => fetch(...a)) {
    return async (url, init) => {
        // A tab that is still becoming a peer finishes that first.
        await peers?.starting;
        const file = storedSha(url);
        // A tab that is not a peer still reads by CID, from /ipfs (LV.14).
        if (!peers || !file || (init?.method && init.method !== 'GET')) return fallback(url, init);
        try {
            const cid = await peers.cidOf(file.sha);
            if (!cid) return fallback(url, init);
            const bytes = await peers.get(cid, file.sha, `${file.ext} ${file.sha.slice(0, 8)}`);
            return new Response(bytes, { status: 200 });
        } catch {
            return fallback(url, init);
        }
    };
}

const blobUrl = (blob) => URL.createObjectURL(blob);

// A tile's file for the engine: {url, filename}, its bytes from the peers.
export async function tileFile(fetchFn, file) {
    const res = await fetchFn(file.url);
    if (!res.ok) throw new Error(`${file.url} -> ${res.status}`);
    if (file.filename !== 'lod-meta.json') return { ...file, url: blobUrl(await res.blob()) };
    // The levels are named in the index, beside it; each comes the same way.
    const meta = await res.json();
    const dir = file.url.slice(0, file.url.lastIndexOf('/'));
    meta.filenames = await Promise.all((meta.filenames ?? []).map(async (name) => {
        const level = await fetchFn(`${dir}/${name}`);
        if (!level.ok) throw new Error(`${dir}/${name} -> ${level.status}`);
        // The engine picks a level's reader by the name at the end of its URL;
        // a blob URL has none, so the name rides in the fragment, which a
        // fetch of the blob ignores.
        return `${blobUrl(await level.blob())}#/${name}`;
    }));
    return { ...file, url: blobUrl(new Blob([JSON.stringify(meta)])) };
}
