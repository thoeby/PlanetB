// atomworker.js — the Web Worker an atom runs in.
//
// Off the main thread so a tab that is compiling the world still renders it,
// and with its own OffscreenCanvas so an atom can rasterise without a document.
// The op names the module: client/atoms/{op}.js, and nothing else.

import { deviceTrouble } from '../lib/brush.js';
import { install as unthrottleTimers } from '../lib/quickyield.js';

// Before anything in this worker sets a timer: brush's glue yields through
// setTimeout(0), and a background tab clamps that to one a second.
unthrottleTimers(globalThis);

const OP = /^[a-z][a-z0-9_]*$/;

const canvas = (w, h) => new OffscreenCanvas(w, h);

// Big outputs go back by transfer, not by copy. Two files can be views into one
// buffer — a tar's entries are — and a buffer may only be transferred once, so
// anything that is not a whole buffer is copied out first.
function transfers(out) {
    const set = new Set();
    for (const f of out?.files ?? []) {
        const b = f.bytes;
        if (b instanceof ArrayBuffer) { set.add(b); continue; }
        if (!ArrayBuffer.isView(b)) continue;
        if (b.byteOffset !== 0 || b.byteLength !== b.buffer.byteLength) {
            f.bytes = new Uint8Array(b);
        }
        set.add(f.bytes.buffer);
    }
    return [...set];
}

// A Rust panic inside a wasm module (client/lib/brush.js) reaches the page as
// an uncaught "RuntimeError: unreachable" with its reason written to this
// worker's console a moment earlier, where nobody looks. The reason is kept
// and sent with the error instead — and with it whatever the GPU device said
// for itself before the panic, which is the difference between "it died here"
// and "it died because the device was lost".
let lastPanic = '';
// The panic, then the device's own complaint (client/lib/brush.js).
const said = () => [lastPanic, deviceTrouble()].filter(Boolean).join(' · ');
const origError = console.error.bind(console);
console.error = (...args) => {
    const text = args.map(String).join(' ');
    if (text.includes('panicked')) lastPanic = text.slice(0, 700);
    origError(...args);
};
self.addEventListener('error', (ev) => {
    self.postMessage({
        error: `${ev.message ?? 'worker error'}${said() ? ` — ${said()}` : ''}`,
        where: `${ev.filename ?? ''}:${ev.lineno ?? ''}`,
    });
});
self.addEventListener('unhandledrejection', (ev) => {
    self.postMessage({
        error: `${ev.reason?.message ?? ev.reason ?? 'rejected'}`
            + (said() ? ` — ${said()}` : ''),
        where: 'unhandled rejection in the atom worker',
    });
});

self.onmessage = async (ev) => {
    const { atom, inputs, apiUrl, filesUrl, knobs } = ev.data;
    try {
        if (!OP.test(atom.op)) throw new Error(`refusing to load atom op '${atom.op}'`);
        const url = new URL(`../atoms/${atom.op}.js`, import.meta.url);
        const mod = await import(url.href);
        const out = await mod.run({
            atom, inputs, apiUrl, filesUrl, canvas, knobs,
            log: (rec) => self.postMessage({ log: rec }),
        });
        self.postMessage({ done: out }, transfers(out));
    } catch (err) {
        // The message, and where it came from, separately: Firefox's err.stack
        // holds only the frames, so sending the stack alone threw the reason
        // away and every failure in the panel read "run@…/assemble.js:291:15".
        self.postMessage({
            error: String(err?.message ?? err) + (said() ? ` — ${said()}` : ''),
            where: String(err?.stack ?? '').split('\n')[0].trim(),
        });
    }
};
