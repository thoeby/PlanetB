// groundworker.js — the ground's geometry, built off the main thread.
//
// client/lib/groundtile.js is arithmetic over a DEM and a floating origin, and
// a 129-grid tile of it is tens of milliseconds; the streamer rebuilds a whole
// level of them whenever the hole in it moves, which was a frozen frame every
// few hundred metres of walking. Here that is somebody else's thread. The
// origin's anchor comes with each request so the vertices land in the frame
// the page is drawing in (client/js/origin.js).

import { groundTile } from './groundtile.js';
import { localFromLonLat } from './tilemath.js';

self.onmessage = (ev) => {
    const { id, z, x, y, dem, anchor, grid, hole, within } = ev.data;
    const localOf = (g) => localFromLonLat(anchor, g.lon, g.lat, g.h ?? 0);
    const t = groundTile(z, x, y, dem, localOf, grid, { hole, within });
    const tile = {
        z, x, y, grid, hole, within, bbox: t.bbox, h: t.h,
        positions: Float32Array.from(t.positions), normals: Float32Array.from(t.normals),
        colors: Float32Array.from(t.colors), indices: Uint32Array.from(t.indices),
    };
    self.postMessage({ id, tile }, [tile.positions.buffer, tile.normals.buffer,
        tile.colors.buffer, tile.indices.buffer, tile.h.buffer]);
};
