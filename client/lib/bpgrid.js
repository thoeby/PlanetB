// bpgrid.js — the Blueprint ground as a grid of chunks (PLAN-editors.md §2.1).
//
// The land is drawn on a regular grid over its bounding box, cut into square
// chunks so a stroke rebuilds the few chunks it touched and not the land
// (`rebuild(rect)` in client/js/blueprint.js). Everything here is arithmetic:
// the page copies the arrays into meshes.
//
// The frame is the region's own: x east, y up, z south, metres from its
// centre, with the earth's curvature taken off y so a kilometre-wide land
// lies where the ECEF frame the rest of the scene uses puts it.

import { litBy, normalOf } from './clay.js';

// Display cells per chunk side.
export const CHUNK = 64;
// Vertices across the land's longer side at most: a 4 km² land is 640 across
// at 3 m, a 700 m field at 1.1 m.
export const MAX_ACROSS = 640;

const EARTH_R = 6371000;

/**
 * The display grid over a bbox [w, s, e, n] at no finer than `cellM` metres.
 */
export function layout(bbox, cellM, { maxAcross = MAX_ACROSS } = {}) {
    const [w, s, e, n] = bbox;
    const lat0 = (s + n) / 2;
    const lon0 = (w + e) / 2;
    const mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
    const mLat = 110540;
    const wide = (e - w) * mLon;
    const tall = (n - s) * mLat;
    const step = Math.max(cellM, Math.max(wide, tall) / maxAcross);
    const cols = Math.max(2, Math.ceil(wide / step) + 1);
    const rows = Math.max(2, Math.ceil(tall / step) + 1);
    return { bbox, lon0, lat0, mLon, mLat, step, cols, rows,
        dLon: (e - w) / (cols - 1), dLat: (n - s) / (rows - 1),
        dx: wide / (cols - 1), dz: tall / (rows - 1) };
}

export const lonAt = (L, i) => L.bbox[0] + i * L.dLon;
export const latAt = (L, j) => L.bbox[3] - j * L.dLat;

// Which vertex a point falls at, fractionally.
export const indexOf = (L, lon, lat) => ({
    i: (lon - L.bbox[0]) / L.dLon, j: (L.bbox[3] - lat) / L.dLat,
});

// A point in the region's frame. `h0` is the height the frame stands at.
export function local(L, lon, lat, h, h0 = 0) {
    const x = (lon - L.lon0) * L.mLon;
    const z = (L.lat0 - lat) * L.mLat;
    return { x, y: h - h0 - (x * x + z * z) / (2 * EARTH_R), z };
}

// Back from the region's frame to degrees and metres.
export function geodetic(L, p, h0 = 0) {
    return { lon: L.lon0 + p.x / L.mLon, lat: L.lat0 - p.z / L.mLat,
        h: p.y + h0 + (p.x * p.x + p.z * p.z) / (2 * EARTH_R) };
}

// Every chunk, as vertex ranges that share their edge vertices.
export function chunksOf(L, size = CHUNK) {
    const out = [];
    for (let j0 = 0; j0 < L.rows - 1; j0 += size) {
        for (let i0 = 0; i0 < L.cols - 1; i0 += size) {
            out.push({ key: `${i0}/${j0}`, i0, j0,
                i1: Math.min(L.cols - 1, i0 + size), j1: Math.min(L.rows - 1, j0 + size) });
        }
    }
    return out;
}

// The chunks a vertex rectangle touches.
export const chunksIn = (chunks, i0, j0, i1, j1) => chunks.filter((c) =>
    c.i1 >= i0 && c.i0 <= i1 && c.j1 >= j0 && c.j0 <= j1);

// Height at a fractional vertex position, bilinearly.
export function heightIn(L, heights, fi, fj) {
    const i = Math.min(L.cols - 2, Math.max(0, Math.floor(fi)));
    const j = Math.min(L.rows - 2, Math.max(0, Math.floor(fj)));
    const u = Math.min(1, Math.max(0, fi - i));
    const v = Math.min(1, Math.max(0, fj - j));
    const k = j * L.cols + i;
    return heights[k] * (1 - u) * (1 - v) + heights[k + 1] * u * (1 - v)
        + heights[k + L.cols] * (1 - u) * v + heights[k + L.cols + 1] * u * v;
}

// The slope in degrees at a vertex, from its four neighbours.
export function slopeAt(L, heights, i, j) {
    return shapeAt(L, heights, i, j).slope;
}

function shapeAt(L, h, i, j) {
    const { cols, rows } = L;
    return normalOf(h[j * cols + Math.max(i - 1, 0)], h[j * cols + Math.min(i + 1, cols - 1)],
        h[Math.max(j - 1, 0) * cols + i], h[Math.min(j + 1, rows - 1) * cols + i],
        i > 0 && i < cols - 1 ? L.dx : L.dx / 2 || 1,
        j > 0 && j < rows - 1 ? L.dz : L.dz / 2 || 1);
}

/**
 * One chunk's mesh arrays. `colourOf(k, i, j, slope, lit)` answers [r, g, b].
 * A skirt hangs `skirt` metres down along the chunk's outer edge, so two
 * neighbours at different heights for a frame never show a crack.
 */
export function chunkGeometry(L, heights, chunk, colourOf, { h0 = 0, skirt = 0 } = {}) {
    const { i0, j0, i1, j1 } = chunk;
    const w = i1 - i0 + 1;
    const hgt = j1 - j0 + 1;
    const n = w * hgt;
    const ring = skirt ? 2 * (w + hgt) - 4 : 0;
    const positions = new Float32Array((n + ring) * 3);
    const normals = new Float32Array((n + ring) * 3);
    const colors = new Float32Array((n + ring) * 3);
    for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
            const k = j * L.cols + i;
            const o = ((j - j0) * w + (i - i0)) * 3;
            const p = local(L, lonAt(L, i), latAt(L, j), heights[k], h0);
            const s = shapeAt(L, heights, i, j);
            positions[o] = p.x; positions[o + 1] = p.y; positions[o + 2] = p.z;
            normals[o] = s.nx; normals[o + 1] = s.ny; normals[o + 2] = s.nz;
            colors.set(colourOf(k, i, j, s.slope, litBy(s.nx, s.ny, s.nz)), o);
        }
    }
    const indices = gridIndices(w, hgt, skirt ? edgeOf(w, hgt) : null, n);
    if (skirt) hangSkirt(positions, normals, colors, w, hgt, n, skirt);
    return { positions, normals, colors, indices };
}

// The vertex indices around a w×h grid's edge, in order.
function edgeOf(w, h) {
    const out = [];
    for (let i = 0; i < w; i++) out.push(i);
    for (let j = 1; j < h; j++) out.push(j * w + w - 1);
    for (let i = w - 2; i >= 0; i--) out.push((h - 1) * w + i);
    for (let j = h - 2; j > 0; j--) out.push(j * w);
    return out;
}

function hangSkirt(positions, normals, colors, w, h, n, skirt) {
    edgeOf(w, h).forEach((v, e) => {
        const to = (n + e) * 3;
        positions.set([positions[v * 3], positions[v * 3 + 1] - skirt, positions[v * 3 + 2]], to);
        normals.set(normals.subarray(v * 3, v * 3 + 3), to);
        colors.set(colors.subarray(v * 3, v * 3 + 3), to);
    });
}

function gridIndices(w, h, edge, n) {
    const quads = (w - 1) * (h - 1) + (edge ? edge.length : 0);
    const idx = new Uint32Array(quads * 6);
    let o = 0;
    for (let j = 0; j < h - 1; j++) {
        for (let i = 0; i < w - 1; i++) {
            const a = j * w + i;
            idx.set([a, a + w, a + 1, a + 1, a + w, a + w + 1], o);
            o += 6;
        }
    }
    if (edge) {
        for (let e = 0; e < edge.length; e++) {
            const a = edge[e];
            const b = edge[(e + 1) % edge.length];
            const c = n + e;
            const d = n + (e + 1) % edge.length;
            // The material draws both faces (client/js/blueprint.js), so the
            // skirt is seen from whichever side is open.
            idx.set([a, c, b, b, c, d], o);
            o += 6;
        }
    }
    return idx;
}
