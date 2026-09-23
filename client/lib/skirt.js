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

// The vertex `width` metres past `e`, on the line from its inner neighbour
// `q` through it: position, and with it the height, carried on linearly.
function past(m, e, q, width) {
    const p = m.positions;
    const d = [p[e * 3] - p[q * 3], p[e * 3 + 1] - p[q * 3 + 1], p[e * 3 + 2] - p[q * 3 + 2]];
    const k = width / (Math.hypot(d[0], d[2]) || 1);
    return m.vertex([p[e * 3] + d[0] * k, p[e * 3 + 1] + d[1] * k, p[e * 3 + 2] + d[2] * k],
        m.normals.slice(e * 3, e * 3 + 3), m.colors.slice(e * 3, e * 3 + 3));
}

// `m` is a terrain mesh of n x n vertices laid out row by row (terrain.js
// terrainMesh), before anything else is added to it.
export function skirt(m, n, width) {
    if (!(width > 0) || n < 2) return m;
    const at = (i, j) => j * n + i;
    // Each edge as (edge vertex, the one inward of it), walked in order.
    const edges = [
        (k) => [at(k, 0), at(k, 1)],
        (k) => [at(n - 1, k), at(n - 2, k)],
        (k) => [at(n - 1 - k, n - 1), at(n - 1 - k, n - 2)],
        (k) => [at(0, n - 1 - k), at(1, n - 1 - k)],
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
    const corners = [[0, 0, 1, 1], [n - 1, 0, n - 2, 1], [n - 1, n - 1, n - 2, n - 2],
        [0, n - 1, 1, n - 2]];
    for (const [i, j, ii, jj] of corners) {
        const c = at(i, j);
        const o = past(m, c, at(ii, jj), width * Math.SQRT2);
        const a = past(m, c, at(i, jj), width);
        const b = past(m, c, at(ii, j), width);
        m.tri(c, a, o);
        m.tri(c, o, b);
    }
    return m;
}
