// r32.js — a land's shaped ground, as a file.
//
// FND.9. A player pulls the ground up and pushes it down; what comes out is
// one number per cell, in metres, relative to the elevation the operator's
// DEM says is there. Relative, because the DEM can be replaced with a better
// one and what somebody shaped is still what they shaped.
//
// The file is immutable and content-addressed like every other (Invariant 1),
// so every save writes a new one and `height_edit` points at it.
//
//   magic   "R32\0"
//   u32     the length of the header, little-endian
//   header  JSON: {version, bbox: [w, s, e, n], cell, width, height}
//   data    float32 little-endian, row-major, north row first
//
// `bbox` is lon/lat, `cell` is metres, and `width` x `height` is the grid that
// covers the land's own bounding box. The format is written down in
// docs/rendering.md.

export const ALGO = 'r32-v1';

const MAGIC = [0x52, 0x33, 0x32, 0x00];

export function writeR32({ bbox, cell, width, height, data }) {
    const json = JSON.stringify({
        version: ALGO, bbox: bbox.map((v) => Number(v)), cell: Number(cell),
        width, height,
    });
    // Padded with spaces to a multiple of four, so the floats behind it start
    // where a Float32Array can be laid over them.
    const head = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
    const out = new Uint8Array(8 + head.length + width * height * 4);
    out.set(MAGIC, 0);
    new DataView(out.buffer).setUint32(4, head.length, true);
    out.set(head, 8);
    const cells = new Float32Array(out.buffer, 8 + head.length, width * height);
    cells.set(data.subarray ? data.subarray(0, width * height) : data);
    return out;
}

export function readR32(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (MAGIC.some((b, i) => u8[i] !== b)) throw new Error('not an r32 file');
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const len = view.getUint32(4, true);
    const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + len)));
    const at = u8.byteOffset + 8 + len;
    const n = head.width * head.height;
    // The header is padded to a multiple of four, but a file may still land in
    // a buffer at an odd offset; then it is copied rather than refused.
    const data = at % 4 === 0
        ? new Float32Array(u8.buffer, at, n)
        : new Float32Array(u8.slice(8 + len, 8 + len + n * 4).buffer);
    return { ...head, data };
}

// The grid a land gets: its own bounding box at the z18 cell size, which is
// the finest the world is ever compiled at (512 cells across a z18 tile).
export const CELLS_PER_TILE = 512;

// At most this many cells across, so one very large land cannot ask the page
// for a hundred megabytes. A land wider than that is shaped at a coarser cell,
// and the file says which.
export const MAX_CELLS = 2048;

/**
 * @param {number[]} bbox [west, south, east, north] in degrees
 * @param {number} metresPerDegree how wide a degree of longitude is here
 */
export function gridFor(bbox, cellMetres) {
    const [west, south, east, north] = bbox;
    const mid = (south + north) / 2;
    const mPerDegLon = 111320 * Math.cos(mid * Math.PI / 180);
    const mPerDegLat = 110540;
    const across = Math.max(1, Math.round((east - west) * mPerDegLon / cellMetres));
    const down = Math.max(1, Math.round((north - south) * mPerDegLat / cellMetres));
    const scale = Math.max(1, across / MAX_CELLS, down / MAX_CELLS);
    const width = Math.max(2, Math.ceil(across / scale));
    const height = Math.max(2, Math.ceil(down / scale));
    return { bbox, cell: cellMetres * scale, width, height,
        data: new Float32Array(width * height) };
}

// What the grid says at a point, bilinearly. Outside it, nothing: a land's
// shaping is the land's own and stops at its edge.
export function sampleR32(grid, lon, lat) {
    const [west, south, east, north] = grid.bbox;
    if (lon < west || lon > east || lat < south || lat > north) return 0;
    const u = (lon - west) / (east - west) * (grid.width - 1);
    const v = (north - lat) / (north - south) * (grid.height - 1);
    const i = Math.min(grid.width - 2, Math.max(0, Math.floor(u)));
    const j = Math.min(grid.height - 2, Math.max(0, Math.floor(v)));
    const fu = Math.min(1, Math.max(0, u - i));
    const fv = Math.min(1, Math.max(0, v - j));
    const at = (a, b) => grid.data[b * grid.width + a] ?? 0;
    return at(i, j) * (1 - fu) * (1 - fv) + at(i + 1, j) * fu * (1 - fv)
        + at(i, j + 1) * (1 - fu) * fv + at(i + 1, j + 1) * fu * fv;
}
