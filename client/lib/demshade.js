// demshade.js — a rectangle of the world's ground, hillshaded onto a 2D canvas.
//
// The map in the corner shades the ground the player is standing on, from the
// mesh that is already in the scene (client/js/hudmap.js). This is the other
// case: a tool that draws a rectangle of the world nobody is standing in — the
// admin's land map, which was a dark box with outlines floating in it and no
// way to tell a valley from a ridge.
//
// One cut tile is enough for that. The store falls back to an ancestor when
// the tile asked for has not been cut (client/lib/geo.js loadRaster), so the
// tile that contains the whole rectangle is one request and whatever the world
// actually has answers it.

import * as tm from './tilemath.js';
import { NODATA_ELEVATION_M, loadDem, sampleHeight } from './geo.js';

// The deepest tile that holds the whole rectangle. Deeper is finer, and a
// rectangle straddling a tile boundary at one zoom is inside a single tile two
// zooms up, so this walks down until it stops being true.
export function tileOver({ west, south, east, north }) {
    let found = { z: tm.MIN_ZOOM, x: 0, y: 0 };
    for (const z of tm.ZOOMS) {
        const x = tm.tileX(west, z);
        const y = tm.tileY(north, z);
        if (tm.tileX(east, z) !== x || tm.tileY(south, z) !== y) break;
        found = { z, x, y };
    }
    return found;
}

// The ground over a rectangle, or null where the world has none there. `at` is
// the height in metres at a lon/lat, and it is arithmetic once this resolves —
// a tool redraws on every click and must not refetch.
export async function groundOver(rect, { filesUrl = '', fetchFn, version = '' } = {}) {
    if (!Number.isFinite(rect?.west) || !Number.isFinite(rect?.north)) return null;
    const { z, x, y } = tileOver(rect);
    const dem = await loadDem(z, x, y, { filesUrl, fetchFn, version }).catch(() => null);
    if (!dem) return null;
    return {
        z,
        x,
        y,
        // Null outside the tile, and null where the survey never reached.
        // The store writes fill as an elevation of zero
        // (server/splatworld/dem.py) and a cut is refused only when the whole
        // of it is fill (client/lib/geo.js loadRaster), so one tile over a
        // thirty-kilometre view arrives with a few surveyed kilometres in it
        // and fill for the rest. Unfiltered, that fill is ground at sea level:
        // shadeRect took its `low` from it, squeezed the real hillside into
        // the top of the range as one bright square, and painted the other
        // nine tenths of the map a flat olive that reads as land. The land map
        // said the world was everywhere and its terrain was one patch.
        at(lon, lat) {
            const { u, v } = inTile(z, x, y, lon, lat);
            if (u < 0 || v < 0 || u > 1 || v > 1) return null;
            const h = sampleHeight(dem, u, v);
            return h === NODATA_ELEVATION_M ? null : h;
        },
    };
}

// Where (lon, lat) falls inside tile (z, x, y), in 0..1 across and down.
export function inTile(z, x, y, lon, lat) {
    const n = 2 ** z;
    const phi = Math.max(-tm.MAX_LAT, Math.min(tm.MAX_LAT, lat)) * tm.RAD_PER_DEG;
    return {
        u: (lon + 180) / 360 * n - x,
        v: (1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * n - y,
    };
}

// The same hillshade the map in the corner draws, over a rectangle rather than
// around a player: a fixed sun from the north-west on the slope between one
// cell and the next, and the valley floor up in the colour. `cell` is the
// square painted, in pixels — coarse enough that a redraw is a few hundred
// lookups rather than a hundred thousand.
export function shadeRect(ctx, ground, {
    west, south, east, north, x0, y0, w, h, cell = 5,
}) {
    if (!ground) return false;
    const cols = Math.ceil(w / cell) + 1;
    const rows = Math.ceil(h / cell) + 1;
    const lonOf = (i) => west + ((i * cell) / w) * (east - west);
    const latOf = (j) => north - ((j * cell) / h) * (north - south);
    const grid = [];
    let seen = false;
    for (let j = 0; j <= rows; j++) {
        const row = [];
        for (let i = 0; i <= cols; i++) {
            const v = ground.at(lonOf(i), latOf(j));
            if (v !== null) seen = true;
            row.push(v);
        }
        grid.push(row);
    }
    if (!seen) return false;
    // The metres one cell is worth, so the slope reads the same whether the
    // rectangle is four kilometres or forty.
    const step = Math.max(((east - west) / w) * cell * 111320
        * Math.cos((((north + south) / 2) * Math.PI) / 180), 1);
    // Lightness runs over this rectangle's own range rather than over a fixed
    // sea-to-summit scale. A four-kilometre valley is fifty metres of relief,
    // and on an absolute scale that is one grey: what the tool is for is
    // telling one end of the map from the other.
    const seenAt = grid.flat().filter((v) => v !== null);
    const low = Math.min(...seenAt);
    const span = Math.max(Math.max(...seenAt) - low, 1);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.clip();
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const here = grid[j][i];
            if (here === null) continue;
            const east_ = grid[j][i + 1] ?? here;
            const south_ = grid[j + 1]?.[i] ?? here;
            const lit = Math.max(0, Math.min(1,
                0.5 + (here - east_ + (here - south_)) / (step * 0.5)));
            const high = (here - low) / span;
            const base = 40 + high * 120;
            const v = Math.round(Math.min(210, base * (0.62 + 0.62 * lit)));
            ctx.fillStyle = `rgb(${Math.round(v * 0.9)},${v},${Math.round(v * 0.76)})`;
            ctx.fillRect(x0 + i * cell, y0 + j * cell, cell + 1, cell + 1);
        }
    }
    ctx.restore();
    return true;
}
