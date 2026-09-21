// quickyield.js — a yield to the event loop that a background tab does not
// slow down.
//
// The trainer yields between steps so the browser gets a task in — brush's
// own runtime does the same inside its wasm, through setTimeout(0). A tab in
// the background has its timers clamped to one wake a second, dedicated
// workers included, and a player renders in one tab while they play in
// another: every step then waited most of a second on a timer, on any GPU,
// which is the "700 to 2 000 ms a step" a run showed beside a demo doing
// forty steps a second in the tab in front. A MessageChannel post is a task
// too, and the clamp does not touch it.
//
// `install(g)` routes every zero-delay setTimeout on `g` — the worker's
// global, so brush's glue goes through it as well — over a channel; timers
// with a real delay are left to the clock. `yieldTask()` is the same for a
// caller that wants one. `uninstall(g)` puts the clock back and closes the
// channel, which an open port would otherwise keep node's event loop alive
// on (the tests); a browser worker lives as long as its tab.

const pending = new Map();
let next = 1;

export function install(g = globalThis) {
    if (!g.MessageChannel || g.__quickyield) return g;
    const ch = new g.MessageChannel();
    ch.port1.onmessage = (ev) => {
        const fn = pending.get(ev.data);
        pending.delete(ev.data);
        fn?.();
    };
    const setT = g.setTimeout.bind(g);
    const clearT = g.clearTimeout.bind(g);
    g.setTimeout = (fn, delay = 0, ...args) => {
        if (Number(delay) > 0 || typeof fn !== 'function') return setT(fn, delay, ...args);
        const id = -(next++);
        pending.set(id, () => fn(...args));
        ch.port2.postMessage(id);
        return id;
    };
    g.clearTimeout = (id) => {
        if (typeof id === 'number' && id < 0) pending.delete(id);
        else clearT(id);
    };
    g.__quickyield = () => {
        ch.port1.close();
        ch.port2.close();
        g.setTimeout = setT;
        g.clearTimeout = clearT;
        delete g.__quickyield;
    };
    return g;
}

export function uninstall(g = globalThis) {
    g.__quickyield?.();
}

export function yieldTask(g = globalThis) {
    if (!g.MessageChannel) return new Promise((r) => g.setTimeout(r, 0));
    return new Promise((r) => {
        const ch = new g.MessageChannel();
        ch.port1.onmessage = () => { ch.port1.close(); ch.port2.close(); r(); };
        ch.port2.postMessage(0);
    });
}
