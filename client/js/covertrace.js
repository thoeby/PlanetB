// covertrace.js — the cover inside a land, as the land's own shapes.
//
// FND.13. Assigning land hands over the ground with it: what the operator's
// cover says is there becomes features on the land, which the landholder can
// edit in QGIS, cut a clearing out of, and send for approval like anything
// else they build. It runs in the assigning admin's tab (Invariant 9) and it
// writes nothing but rows — assigning still renders nothing (story 2).
//
// Two departures from TASKS-foundation.md FND.13, both for the same reason:
// the sources are ten-metre and two-metre data.
//
//   * The classes are read from the z16 cut, not z18. A z18 cut of a land is
//     forty-nine files to ask the store for; z16 is four, and at 0.8 m a
//     sample it is finer than anything the sources know.
//   * They are traced at two metres, not at the raster's own cell. Tracing
//     ESA WorldCover at twenty centimetres does not find a finer forest edge,
//     it finds the same edge with a hundred times as many corners in it.

import * as api from './api.js';
import { classAt, coverGrid } from './covergrid.js';
import { shapesOf } from '../lib/gen/trace.js';
import { contains } from '../lib/poly.js';

// How fine the shapes are traced, and the smallest patch worth a row of its
// own — a tenth of an are, which is a tree, not a wood.
const CELL_M = 2;
const SIMPLIFY_M = 0.5;
const SMALLEST_M2 = 10;

const ringsOf = (outline) => {
    if (outline?.type === 'Polygon') return outline.coordinates;
    if (outline?.type === 'MultiPolygon') return outline.coordinates.flat();
    return [];
};

/**
 * The shapes the cover would put on one land.
 *
 * @param {object} area a land, as area_view gives it
 * @param {object[]} sources the applied cover mapping (db/0166 pinned_cover)
 * @param {object} how {filesUrl, onStep}
 * @returns {Promise<object[]>} {kind, props, geom} ready for `copy_cover`
 */
export async function coverShapesFor(area, sources, how = {}) {
    const rings = ringsOf(area?.outline);
    if (!rings.length || !sources?.length) return [];
    const grid = await coverGrid(area.bbox, CELL_M, sources, how);
    // Inset by a cell: a ring traced along the edge of the land wanders half a
    // cell either side of it, and a feature that crosses the boundary is
    // refused (db/0038). The land keeps its own metre.
    const on = (i, j) => {
        for (const [di, dj] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const at = grid.lonLat(i + di, j + dj);
            if (!contains(rings, at[0], at[1])) return false;
        }
        return true;
    };
    const out = [];
    for (const [key, what] of grid.classes) {
        how.onStep?.(what);
        const is = (i, j) => on(i, j) && grid.at(i, j) === key;
        const shapes = shapesOf(is, grid.width, grid.height, {
            toWorld: (x, y) => grid.lonLat(x - 0.5, y - 0.5),
            tolerance: SIMPLIFY_M / grid.metresPerCell,
            smallest: SMALLEST_M2 / grid.metresPerCell ** 2,
        });
        for (const ring of shapes) {
            out.push({ kind: what.kind, props: { [what.key]: what.value },
                geom: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } });
        }
    }
    return out;
}

/**
 * Trace the cover inside a land and give it to the land.
 *
 * @returns {Promise<{copied: number, already: boolean}>}
 */
export async function copyCoverTo(area, how = {}) {
    const sources = await api.rpc('pinned_cover').catch(() => []);
    if (!sources?.length) return { copied: 0, already: false };
    const shapes = await coverShapesFor(area, sources, how);
    if (!shapes.length) return { copied: 0, already: false };
    return api.rpc('copy_cover', { area: area.id, shapes });
}

export { classAt };
