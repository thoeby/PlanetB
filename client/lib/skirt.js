// skirt.js — the ground carried a few metres past the tile's edge.
//
// The terrain mesh stops exactly at the tile's edge, and past it the frames
// are transparent (client/lib/raster.js). brush is trained towards that
// transparency (match-alpha-weight), so the splats along the edge were pulled
// thin and faint, and two trained tiles met with a seam between them that
// neither had ground in. The skirt continues each edge outwards by `width`
// metres along the slope the edge already has, in the edge's own colour: the
// frames see ground there, the edge splats are trained as covered as the rest,
// and neighbouring tiles overlap by the skirt rather than fade apart.
//
// Only the ground the frames draw gets one. The heightfield the player walks
// on (terrain.js heightRaster) is still exactly the tile.

// How many cells inward the slope carried out is measured over, and the
// steepest it may be. The first skirt took it from the next vertex in, 0.8 m
// away, and carried it 7.5 m: one steep or noisy cell of an alpine survey
// became a wall tens of metres high, every tile was fenced in by them, the
// ring cameras standing near the edge saw them close up, and brush filled
// the tile with big soft splats reproducing them.
export const SLOPE_CELLS = 8;
export const MAX_SLOPE = 2;

// The vertex `width` metres past `e`, on the line from `q` (some cells in)
// through it: the plan direction, and the height carried on at that line's
// slope, no steeper than MAX_SLOPE.
function past(m, e, q, width) {
    const p = m.positions;
    const d = [p[e * 3] - p[q * 3], p[e * 3 + 1] - p[q * 3 + 1], p[e * 3 + 2] - p[q * 3 + 2]];
    const run = Math.hypot(d[0], d[2]) || 1;
    const rise = Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, d[1] / run)) * width;
    return m.vertex([p[e * 3] + d[0] / run * width, p[e * 3 + 1] + rise,
        p[e * 3 + 2] + d[2] / run * width],
    m.normals.slice(e * 3, e * 3 + 3), m.colors.slice(e * 3, e * 3 + 3));
}

// `m` is a terrain mesh of n x n vertices laid out row by row (terrain.js
// terrainMesh), before anything else is added to it.
export function skirt(m, n, width) {
    if (!(width > 0) || n < 2) return m;
    const at = (i, j) => j * n + i;
    const c = Math.min(SLOPE_CELLS, n - 1);
    // Each edge as (edge vertex, the one `c` cells inward of it), in order.
    const edges = [
        (k) => [at(k, 0), at(k, c)],
        (k) => [at(n - 1, k), at(n - 1 - c, k)],
        (k) => [at(n - 1 - k, n - 1), at(n - 1 - k, n - 1 - c)],
        (k) => [at(0, n - 1 - k), at(c, n - 1 - k)],
    ];
    for (const edge of edges) {
        let prev = null;
        for (let k = 0; k < n; k++) {
            const [e, q] = edge(k);
            const o = past(m, e, q, width);
            if (prev) {
                m.tri(prev.e, prev.o, e);
                m.tri(e, prev.o, o);
            }
            prev = { e, o };
        }
    }
    // The four corners, out along the diagonal, so the skirt has no notch.
    const corners = [[0, 0, c, c], [n - 1, 0, n - 1 - c, c], [n - 1, n - 1, n - 1 - c, n - 1 - c],
        [0, n - 1, c, n - 1 - c]];
    for (const [i, j, ii, jj] of corners) {
        const v = at(i, j);
        const o = past(m, v, at(ii, jj), width * Math.SQRT2);
        const a = past(m, v, at(i, jj), width);
        const b = past(m, v, at(ii, j), width);
        m.tri(v, a, o);
        m.tri(v, o, b);
    }
    return m;
}
