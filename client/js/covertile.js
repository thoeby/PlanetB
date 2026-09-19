// covertile.js — the classes one cover source actually has, read off the
// ground the world cut for it.
//
// FND.12. The mapping table cannot offer classes nobody has seen, and the
// operator should not have to type them out of a data sheet. So the panel
// reads the same picture the compiler reads (client/lib/gen/cover.js): the
// store serves one source's own cut at /geo/cover-<id>/…, beside the composed
// one the compiler is handed, and the distinct colours in it are the classes.
//
// Nothing is decided here. A colour is a class; what it *means* is the row the
// operator writes next to it.

import * as api from './api.js';
import { hexOf } from '../lib/gen/cover.js';
import { tileX, tileY } from '../lib/tilemath.js';

// The compile unit (z14): big enough that one tile of a source usually holds
// every class it has, small enough that the store can cut it while somebody
// waits.
const READ_Z = 14;

/** Where this source's own cut of the tile over its middle is. */
export function coverTileUrl(source, z = READ_Z) {
    const box = source?.extent ?? {};
    const lon = ((box.west ?? 0) + (box.east ?? 0)) / 2;
    const lat = ((box.south ?? 0) + (box.north ?? 0)) / 2;
    return `${api.endpoints().files}/geo/cover-${source.id}/${z}`
        + `/${tileX(lon, z)}/${tileY(lat, z)}.png`;
}

async function pixelsOf(url) {
    const res = await fetch(url);
    if (res.status === 404) throw new Error('the world has not cut that source yet');
    if (!res.ok) throw new Error(`${res.status} from the store`);
    const bitmap = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

/**
 * The distinct classes in one source's cut, commonest first.
 *
 * @param {string} url from coverTileUrl
 * @param {number} most how many to report — a source with hundreds of classes
 *        is a source somebody styled wrong, and a table of hundreds is no use
 * @returns {Promise<{colour: string, count: number}[]>}
 */
export async function classesIn(url, most = 64) {
    const data = await pixelsOf(url);
    const seen = new Map();
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        const hex = hexOf(data[i], data[i + 1], data[i + 2]);
        seen.set(hex, (seen.get(hex) ?? 0) + 1);
    }
    return [...seen.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, most)
        .map(([colour, count]) => ({ colour, count }));
}
