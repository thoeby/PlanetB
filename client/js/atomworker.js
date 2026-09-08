// atomworker.js — the Web Worker an atom runs in.
//
// Off the main thread so a tab that is compiling the world still renders it,
// and with its own OffscreenCanvas so an atom can rasterise without a document.
// The op names the module: client/atoms/{op}.js, and nothing else.

const OP = /^[a-z][a-z0-9_]*$/;

const canvas = (w, h) => new OffscreenCanvas(w, h);

// Big outputs go back by transfer, not by copy.
function transfers(out) {
    const list = [];
    for (const f of out?.files ?? []) {
        const b = f.bytes;
        if (b instanceof ArrayBuffer) list.push(b);
        else if (ArrayBuffer.isView(b)) list.push(b.buffer);
    }
    return list;
}

self.onmessage = async (ev) => {
    const { atom, inputs, apiUrl, filesUrl } = ev.data;
    try {
        if (!OP.test(atom.op)) throw new Error(`refusing to load atom op '${atom.op}'`);
        const url = new URL(`../atoms/${atom.op}.js`, import.meta.url);
        const mod = await import(url.href);
        const out = await mod.run({
            atom, inputs, apiUrl, filesUrl, canvas,
            log: (rec) => self.postMessage({ log: rec }),
        });
        self.postMessage({ done: out }, transfers(out));
    } catch (err) {
        self.postMessage({ error: String(err?.stack ?? err) });
    }
};
