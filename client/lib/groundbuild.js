// groundbuild.js — where a ground tile's geometry gets built: in a Worker when
// the page has one and the origin has an anchor to send it, on the calling
// thread otherwise (node, and the tests that hand in their own localOf).
//
// One promise per request. A newer request for the same tile makes the older
// answer worthless, and the streamer decides that (client/lib/groundmesh.js
// keeps a serial per tile); this only builds.

import { groundTile } from './groundtile.js';

export function makeBuilder({ origin, localOf }) {
    const canWork = typeof Worker !== 'undefined' && origin?.anchor;
    if (!canWork) {
        return {
            build: (z, x, y, dem, grid, opts) =>
                Promise.resolve(groundTile(z, x, y, dem, localOf(), grid, opts)),
            stop() {},
        };
    }
    const worker = new Worker(new URL('./groundworker.js', import.meta.url),
        { type: 'module' });
    const waiting = new Map();
    let next = 1;
    worker.onmessage = (ev) => {
        const { id, tile } = ev.data;
        const w = waiting.get(id);
        waiting.delete(id);
        w?.resolve(tile);
    };
    worker.onerror = (e) => {
        for (const w of waiting.values()) w.reject(new Error(e.message ?? 'ground worker failed'));
        waiting.clear();
    };
    return {
        build(z, x, y, dem, grid, { hole = null, within = null } = {}) {
            const id = next++;
            return new Promise((resolve, reject) => {
                waiting.set(id, { resolve, reject });
                worker.postMessage({ id, z, x, y, dem, grid, hole, within,
                    // The anchor as it is now: a rebase sends new requests.
                    anchor: { ...origin.anchor } });
            }).then((tile) => ({ ...tile, dem }));
        },
        stop() { worker.terminate(); waiting.clear(); },
    };
}
