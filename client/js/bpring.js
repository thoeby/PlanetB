// bpring.js — the dimmed kilometre around the land in Blueprint (EDT.1): the
// elevation only, coarse, with a hole where the land's own mesh is, and the
// z14 tiles the whole region falls in.

import { chunkGeometry, latAt, layout, lonAt } from '../lib/bpgrid.js';
import { linear, vertexColour } from '../lib/clay.js';
import * as tm from '../lib/tilemath.js';

const RING_ACROSS = 160;
// The ring is drawn this far under the land's mesh, so where the two overlap
// at the land's edge the land is the one you see.
const RING_BELOW_M = 0.5;
const Z = 14;

// The dimmed kilometre around the land: the elevation only, coarse, with
// a hole where the land's own mesh is.
export function buildRing(bp, outer, box) {
    const R = layout(outer, 1, { maxAcross: RING_ACROSS });
    const heights = new Float32Array(R.cols * R.rows);
    for (let j = 0; j < R.rows; j++) {
        for (let i = 0; i < R.cols; i++) {
            heights[j * R.cols + i] = (bp.demAt(lonAt(R, i), latAt(R, j)) ?? bp.h0)
                - RING_BELOW_M;
        }
    }
    const all = { key: 'ring', i0: 0, j0: 0, i1: R.cols - 1, j1: R.rows - 1 };
    const geo = chunkGeometry(R, heights, all, (k, i, j, slope, lit) =>
        linear(vertexColour({ slope, lit, inside: false, delta: 0 })), { h0: bp.h0 });
    const keep = [];
    for (let q = 0; q < geo.indices.length; q += 6) {
        const cx = [geo.indices[q], geo.indices[q + 5]].map((v) => v % R.cols);
        const cz = [geo.indices[q], geo.indices[q + 5]].map((v) => Math.floor(v / R.cols));
        const lonA = lonAt(R, cx[0]); const lonB = lonAt(R, cx[1]);
        const latA = latAt(R, cz[0]); const latB = latAt(R, cz[1]);
        const within = Math.min(lonA, lonB) > box[0] && Math.max(lonA, lonB) < box[2]
            && Math.min(latA, latB) > box[1] && Math.max(latA, latB) < box[3];
        if (!within) keep.push(...geo.indices.subarray(q, q + 6));
    }
    const mesh = new bp.pc.Mesh(bp.app.graphicsDevice);
    mesh.setPositions(shift(geo.positions, R, bp.L));
    mesh.setNormals(geo.normals);
    mesh.setColors(geo.colors, 3);
    mesh.setIndices(new Uint32Array(keep));
    mesh.update(bp.pc.PRIMITIVE_TRIANGLES);
    return bp.meshEntity('blueprint ring', mesh);
}

// A bbox grown by metres each way.
export function grow(box, metres) {
    const lat = (box[1] + box[3]) / 2;
    const dLon = metres / (111320 * Math.cos(lat * Math.PI / 180));
    const dLat = metres / 110540;
    return [box[0] - dLon, box[1] - dLat, box[2] + dLon, box[3] + dLat];
}

export function z14Keys(box) {
    const out = [];
    for (let x = tm.tileX(box[0], Z); x <= tm.tileX(box[2], Z); x++) {
        for (let y = tm.tileY(box[3], Z); y <= tm.tileY(box[1], Z); y++) out.push([x, y]);
    }
    return out;
}

// The ring was laid out in its own frame; the land's is the one the root
// stands in, so the ring's vertices are moved into it.
function shift(positions, R, L) {
    const dx = (R.lon0 - L.lon0) * L.mLon;
    const dz = (L.lat0 - R.lat0) * L.mLat;
    const out = new Float32Array(positions.length);
    for (let o = 0; o < positions.length; o += 3) {
        out[o] = positions[o] + dx;
        out[o + 1] = positions[o + 1];
        out[o + 2] = positions[o + 2] + dz;
    }
    return out;
}

