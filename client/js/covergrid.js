// covergrid.js — the ground cover over one land, as a grid of classes.
//
// FND.13. The store cuts the cover per tile, composed from the operator's
// sources (server/splatworld/ground.py); this lays the tiles a land touches
// over the land's own box and reads a class out of them, so the tracer has one
// grid to walk rather than four pictures to stitch.
//
// Nothing is decided here: a pixel is a colour, and which of the world's words
// that colour is is the operator's mapping (db/0166).

import * as api from './api.js';
import { hexOf } from '../lib/gen/cover.js';
import { MAX_LAT, RAD_PER_DEG } from '../lib/tilemath.js';

// Cut at z16: four files for a land rather than forty-nine, and 0.8 m a
// sample, which is finer than any cover source publishes.
const READ_Z = 16;

const M_PER_LAT = 110540;
const mPerLon = (lat) => 111320 * Math.cos(lat * Math.PI / 180);

// Where a point is in its own tile, as Web-Mercator tiles nest.
function atTile(lon, lat, z) {
    const n = 2 ** z;
    const fx = (lon + 180) / 360 * n;
    const phi = Math.min(Math.max(lat, -MAX_LAT), MAX_LAT) * RAD_PER_DEG;
    const fy = (1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * n;
    return { x: Math.floor(fx), y: Math.floor(fy), u: fx % 1, v: fy % 1 };
}

async function pictureOf(url) {
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) return null;
    const bitmap = await createImageBitmap(await res.blob()).catch(() => null);
    if (!bitmap) return null;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    return { size: bitmap.width,
        data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data };
}

/** The colour of the cover at a point, or null where nothing is cut. */
export function classAt(tiles) {
    return (lon, lat) => {
        const at = atTile(lon, lat, READ_Z);
        const img = tiles.get(`${at.x}/${at.y}`);
        if (!img) return null;
        const i = Math.min(Math.floor(at.u * img.size), img.size - 1);
        const j = Math.min(Math.floor(at.v * img.size), img.size - 1);
        const k = (j * img.size + i) * 4;
        if (img.data[k + 3] < 128) return null;
        return hexOf(img.data[k], img.data[k + 1], img.data[k + 2]);
    };
}

/**
 * One land's cover, on a grid of its own.
 *
 * @param {object} bbox {west, south, east, north}
 * @param {number} cellM how many metres a cell is
 * @param {object[]} sources the applied mapping, for what a colour means
 * @param {object} how {filesUrl}
 */
export async function coverGrid(bbox, cellM, sources, how = {}) {
    const filesUrl = how.filesUrl ?? api.endpoints().files;
    const tiles = new Map();
    const nw = atTile(bbox.west, bbox.north, READ_Z);
    const se = atTile(bbox.east, bbox.south, READ_Z);
    for (let y = nw.y; y <= se.y; y++) {
        for (let x = nw.x; x <= se.x; x++) {
            const img = await pictureOf(`${filesUrl}/geo/cover/${READ_Z}/${x}/${y}.png`);
            if (img) tiles.set(`${x}/${y}`, img);
        }
    }
    const mid = (bbox.south + bbox.north) / 2;
    const width = Math.max(2, Math.round((bbox.east - bbox.west) * mPerLon(mid) / cellM));
    const height = Math.max(2, Math.round((bbox.north - bbox.south) * M_PER_LAT / cellM));
    const lonLat = (i, j) => [
        bbox.west + (bbox.east - bbox.west) * (i + 0.5) / width,
        bbox.north - (bbox.north - bbox.south) * (j + 0.5) / height,
    ];
    const colour = classAt(tiles);
    const mapped = new Map();
    for (const s of sources ?? []) {
        for (const [key, what] of Object.entries(s.class_map ?? {})) {
            if (!mapped.has(key.toLowerCase())) mapped.set(key.toLowerCase(), what);
        }
    }
    const cells = new Array(width * height).fill(null);
    const seen = new Map();
    for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
            const hex = colour(...lonLat(i, j));
            const what = hex ? mapped.get(hex) : null;
            if (!what) continue;
            cells[j * width + i] = hex;
            if (!seen.has(hex)) seen.set(hex, what);
        }
    }
    return { width, height, metresPerCell: cellM, lonLat, classes: seen,
        at: (i, j) => (i < 0 || j < 0 || i >= width || j >= height
            ? null : cells[j * width + i]) };
}
