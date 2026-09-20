// covermap.js — the ground as it was rendered, on the map.
//
// FND.13. A published tile carries a picture of what its ground was drawn in
// (client/atoms/sog.js), and the store serves the latest one at an address
// that does not change when the tile is rendered again. This draws those
// pictures under the map, so a clearing somebody cut is a clearing on the map
// as well as in the world.
//
// It decides nothing and asks for nothing that is not published: a tile with
// no cover simply is not drawn, and the hillshade underneath shows through.

import * as api from './api.js';
import { tileBbox, tileX, tileY } from '../lib/tilemath.js';

const M_PER_DEG = 111320;

// How many pictures are kept, and how many are asked for at once. The map is
// a hundred and eighty pixels across; a screenful is a handful of tiles.
const KEEP = 64;
const ZOOMS = [14, 12, 10, 8, 6];

const held = new Map();
const asking = new Set();

// One tile's picture, or null while it is on its way or if there is none.
// Under node — where the map's own tests draw it — there is no image loader
// and there are no pictures, which is the same answer as a world nobody has
// compiled yet.
function picture(z, x, y, filesUrl) {
    if (typeof globalThis.Image !== 'function') return null;
    const k = `${z}/${x}/${y}`;
    if (held.has(k)) return held.get(k);
    if (asking.has(k)) return null;
    asking.add(k);
    const img = new globalThis.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        asking.delete(k);
        if (held.size >= KEEP) held.delete(held.keys().next().value);
        held.set(k, img);
    };
    img.onerror = () => {
        asking.delete(k);
        if (held.size >= KEEP) held.delete(held.keys().next().value);
        held.set(k, null);
    };
    img.src = `${filesUrl}/tiles/cover/${z}/${x}/${y}.png`;
    return null;
}

// Which zoom covers a window this wide in a few tiles: the coarsest whose
// tiles are smaller than the window, so one screenful is never a hundred
// requests.
function zoomFor(span, lat) {
    for (const z of ZOOMS) {
        const b = tileBbox(z, tileX(0, z), tileY(lat, z));
        const across = (b.east - b.west) * M_PER_DEG * Math.cos((lat * Math.PI) / 180);
        if (across <= span) return z;
    }
    return ZOOMS.at(-1);
}

/**
 * Draw the published cover over the map's window.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} how {w, h, at, span, cos, filesUrl}
 * @returns {boolean} whether anything was drawn
 */
export function drawCover(ctx, { w, h, at, span, cos, filesUrl = null }) {
    if (!at || !(span > 0)) return false;
    const store = filesUrl ?? api.endpoints().files;
    const z = zoomFor(span, at.lat);
    const metres = span / w;
    // A degree of latitude is M_PER_DEG here as it is everywhere else in this
    // world: it was 110540, so a cover picture sat two parts in a thousand off
    // the boundary drawn over it and the hillshade drawn under it.
    const half = (h / 2) * metres;
    const east = at.lon + (span / 2) / (M_PER_DEG * cos);
    const west = at.lon - (span / 2) / (M_PER_DEG * cos);
    const north = at.lat + half / M_PER_DEG;
    const south = at.lat - half / M_PER_DEG;
    let drew = false;
    for (let y = tileY(north, z); y <= tileY(south, z); y++) {
        for (let x = tileX(west, z); x <= tileX(east, z); x++) {
            const img = picture(z, x, y, store);
            if (!img) continue;
            const b = tileBbox(z, x, y);
            const x0 = w / 2 + ((b.west - at.lon) * M_PER_DEG * cos) / metres;
            const x1 = w / 2 + ((b.east - at.lon) * M_PER_DEG * cos) / metres;
            const y0 = h / 2 - ((b.north - at.lat) * M_PER_DEG) / metres;
            const y1 = h / 2 - ((b.south - at.lat) * M_PER_DEG) / metres;
            ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
            drew = true;
        }
    }
    return drew;
}

/** Forget every picture — the ground was rendered again. */
export function forgetCover() {
    held.clear();
    asking.clear();
}
