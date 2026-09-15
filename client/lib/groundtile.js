// groundtile.js — one tile of ground, as samples and as a mesh.
//
// Split out of client/lib/groundmesh.js when the floor stopped being one ring
// of z14 tiles: the streaming is there, the geometry is here, and the geometry
// is a pure function of a DEM so client/test/groundtile.test.js can check it
// under node with no graphics device.
//
// Three things this has to get right, all of them about the far distance:
//
//  * A tile at z10 is twenty-seven kilometres across and has the same number of
//    samples as one at z14, so the same hillside is a different surface at each
//    level. Where two levels meet, that difference is a crack.
//  * A coarse tile under a finer one would cut through it. So a coarse tile is
//    given the rectangle the finer level covers and leaves a hole in itself.
//  * Along every edge of what it did draw — its own border and the hole's — it
//    hangs a skirt: a wall of the same colour dropping below the surface, which
//    is what fills the crack between two levels that do not agree.

import { sampleHeight } from './geo.js';
import { shade } from './light.js';
import * as tm from './tilemath.js';
import { heightOn, openAt, sunlitAt, terrainColour, worldMetres } from './terrain.js';

// The sky is client/lib/light.js, the same one the frame atom renders under and
// the same one a tile's splats are sampled with. The ground a player walks on
// and the ground a compile renders are then the same picture, which is what
// makes an unrendered tile and a published one read as one world.

// The surface normal at one grid point, from its neighbours' own positions:
// the grid is not flat in the local frame, so the heights alone do not say it.
function normalAt(p, grid, i, j) {
    const at = (ii, jj) => {
        const k = (Math.min(Math.max(jj, 0), grid - 1) * grid
            + Math.min(Math.max(ii, 0), grid - 1)) * 3;
        return [p[k], p[k + 1], p[k + 2]];
    };
    const a = at(i + 1, j);
    const b = at(i - 1, j);
    const c = at(i, j + 1);
    const d = at(i, j - 1);
    const du = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const dv = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
    const n = [dv[1] * du[2] - dv[2] * du[1], dv[2] * du[0] - dv[0] * du[2],
        dv[0] * du[1] - dv[1] * du[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / len, n[1] / len, n[2] / len];
}

// Where (lon, lat) falls inside its tile, 0..1 from the north-west corner.
// Web-Mercator rows are not linear in latitude, so v comes from the same
// arithmetic tileY() rounds down.
// Where a lon/lat sits inside a tile, in 0..1 each way. Web-Mercator, so v is
// not linear in latitude — anything sampling a cut tile has to come through
// here rather than interpolate degrees.
export function inTile(z, x, y, lon, lat) {
    const n = 2 ** z;
    const phi = Math.max(-tm.MAX_LAT, Math.min(tm.MAX_LAT, lat)) * tm.RAD_PER_DEG;
    return {
        u: (lon + 180) / 360 * n - x,
        v: (1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * n - y,
    };
}

// The inverse, for laying the grid out: row v of tile y, as a latitude.
const latOf = (z, y, v) =>
    Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + v) / 2 ** z))) / tm.RAD_PER_DEG;

// Rise over run, in metres per metre, for the colour: steep ground is rock.
// One grid step, east to west, at this tile's latitude.
function slopeAt(h, grid, i, j, b) {
    const mid = (b.south + b.north) / 2;
    const metres = Math.max((b.east - b.west) * tm.RAD_PER_DEG * 6378137
        * Math.cos(mid * tm.RAD_PER_DEG) / (grid - 1), 1);
    const l = h[j * grid + Math.max(i - 1, 0)];
    const r = h[j * grid + Math.min(i + 1, grid - 1)];
    const u = h[Math.max(j - 1, 0) * grid + i];
    const d = h[Math.min(j + 1, grid - 1) * grid + i];
    return Math.hypot((r - l) / (2 * metres), (d - u) / (2 * metres));
}

// One grid step across, in metres, at this latitude. What a skirt is as deep
// as, and what says how far two levels can disagree where they meet.
export function cellMetres(z, grid, lat = 0) {
    const deg = 360 / 2 ** z / Math.max(grid - 1, 1);
    return Math.max(deg * tm.RAD_PER_DEG * 6378137
        * Math.cos(Math.min(Math.abs(lat), 85) * tm.RAD_PER_DEG), 1);
}

// A skirt is as deep as the ground can differ across one cell of it, and no
// deeper: at the edge of the world there is nothing behind it to hide a wall.
export const SKIRT_MAX_M = 400;
export const skirtDepth = (z, grid, lat) =>
    Math.min(cellMetres(z, grid, lat) * 1.5, SKIRT_MAX_M);

// Is this quad inside the rectangle a finer level is drawing? The hole is
// snapped outwards to whole cells by the caller's choice of rectangle: it is
// better to leave a gap the finer level's skirt hangs over than to draw two
// surfaces on top of each other.
const inHole = (hole, lon, lat) => Boolean(hole)
    && lon > hole.west && lon < hole.east && lat > hole.south && lat < hole.north;

// The edge of the world. Outside the operator's coverage there is no
// elevation, and a DEM tile that reaches past it comes back as nodata — which
// is sea level, because a terrain mesh has to be continuous and a NaN travels
// into every vertex that touches it (server/splatworld/dem.py). Drawing that
// puts a plateau at zero metres around a world that starts at six hundred. A
// tile at z10 is twenty-seven kilometres across, so most of one at the edge is
// this: it is not drawn at all, and the skirt hems what is left.
const inWorld = (within, lon, lat) => !within
    || (lon >= within.west && lon <= within.east
        && lat >= within.south && lat <= within.north);

function samples(z, x, y, dem, localOf, grid) {
    const b = tm.tileBbox(z, x, y);
    const h = new Float64Array(grid * grid);
    const lons = new Float64Array(grid);
    const lats = new Float64Array(grid);
    const positions = [];
    for (let j = 0; j < grid; j++) {
        lats[j] = latOf(z, y, j / (grid - 1));
        for (let i = 0; i < grid; i++) {
            if (j === 0) lons[i] = b.west + (b.east - b.west) * (i / (grid - 1));
            const metres = sampleHeight(dem, i / (grid - 1), j / (grid - 1));
            h[j * grid + i] = metres;
            const p = localOf({ lon: lons[i], lat: lats[j], h: metres });
            positions.push(p.x, p.y, p.z);
        }
    }
    return { b, h, lons, lats, positions };
}

// The heights over the tile's own metres, for the shadow's march: the grid is
// even in longitude and latitude, which over one tile is even in metres too.
function heightAt(h, positions, grid) {
    const west = positions[0];
    const north = positions[2];
    const last = (grid - 1) * 3;
    const stepX = (positions[last] - west) / (grid - 1);
    const stepZ = (positions[(grid - 1) * grid * 3 + 2] - north) / (grid - 1);
    return (x, z) => heightOn(h, grid, west, north, stepX, stepZ, x, z);
}

// Lit exactly as assemble-v3 lights a tile's ground (client/lib/terrain.js
// terrainMesh): the same sky, the same shadow, so the two meet without a seam.
function shadeAll(h, positions, grid, b, step, lons, lats) {
    const normals = [];
    const colors = [];
    const hAt = heightAt(h, positions, grid);
    for (let j = 0; j < grid; j++) {
        for (let i = 0; i < grid; i++) {
            const n = normalAt(positions, grid, i, j);
            normals.push(...n);
            const open = openAt(h, grid, i, j, step, step);
            const at = j * grid + i;
            const own = terrainColour(slopeAt(h, grid, i, j, b), h[at], open,
                worldMetres(lons[i], lats[j]));
            const lit = sunlitAt(hAt, positions[at * 3], h[at], positions[at * 3 + 2], step);
            colors.push(...shade(own, n, open, lit));
        }
    }
    return { normals, colors };
}

// The wall under one edge of the surface: the two vertices copied straight
// down, sharing their colour so it reads as ground rather than as a band.
// Deep enough to cover how far a coarser level can be from a finer one.
function skirt(mesh, a, c, deep) {
    const copy = (k) => {
        const at = mesh.positions.length / 3;
        mesh.positions.push(mesh.positions[k * 3], mesh.positions[k * 3 + 1] - deep,
            mesh.positions[k * 3 + 2]);
        mesh.normals.push(mesh.normals[k * 3], mesh.normals[k * 3 + 1],
            mesh.normals[k * 3 + 2]);
        mesh.colors.push(mesh.colors[k * 3], mesh.colors[k * 3 + 1],
            mesh.colors[k * 3 + 2]);
        return at;
    };
    const da = copy(a);
    const dc = copy(c);
    mesh.indices.push(a, da, c, c, da, dc);
}

// z, x, y: the tile. hole: the lon/lat rectangle a finer level is drawing, or
// null. localOf: the floating origin's own (client/js/origin.js), so the
// vertices land in the same frame as everything else and a rebase is a rebuild
// from the geodetic samples this keeps.
export function groundTile(z, x, y, dem, localOf, grid = 65,
    { hole = null, within = null } = {}) {
    const { b, h, lons, lats, positions } = samples(z, x, y, dem, localOf, grid);
    const mid = (b.south + b.north) / 2;
    const { normals, colors } = shadeAll(h, positions, grid, b,
        cellMetres(z, grid, mid), lons, lats);
    const mesh = { positions, normals, colors, indices: [] };
    const deep = skirtDepth(z, grid, mid);
    const covered = [];
    for (let j = 0; j < grid - 1; j++) {
        for (let i = 0; i < grid - 1; i++) {
            const lon = (lons[i] + lons[i + 1]) / 2;
            const lat = (lats[j] + lats[j + 1]) / 2;
            const out = inHole(hole, lon, lat) || !inWorld(within, lon, lat);
            covered.push(out);
            if (out) continue;
            const a = j * grid + i;
            mesh.indices.push(a, a + grid, a + 1, a + 1, a + grid, a + grid + 1);
        }
    }
    hem(mesh, covered, grid, deep);
    return { z, x, y, dem, grid, h, hole, within, bbox: b, ...mesh };
}

// A skirt down every edge of what was drawn: the tile's own border, and the
// border of the hole in the middle of it.
function hem(mesh, covered, grid, deep) {
    const drawn = (i, j) => i >= 0 && j >= 0 && i < grid - 1 && j < grid - 1
        && !covered[j * (grid - 1) + i];
    for (let j = 0; j < grid - 1; j++) {
        for (let i = 0; i < grid - 1; i++) {
            if (!drawn(i, j)) continue;
            const a = j * grid + i;
            if (!drawn(i, j - 1)) skirt(mesh, a + 1, a, deep);
            if (!drawn(i, j + 1)) skirt(mesh, a + grid, a + grid + 1, deep);
            if (!drawn(i - 1, j)) skirt(mesh, a, a + grid, deep);
            if (!drawn(i + 1, j)) skirt(mesh, a + grid + 1, a + 1, deep);
        }
    }
}

// Bilinear height inside one loaded tile, in metres.
export function heightIn(tile, lon, lat) {
    const { u, v } = inTile(tile.z, tile.x, tile.y, lon, lat);
    if (u < 0 || v < 0 || u > 1 || v > 1) return null;
    const g = tile.grid;
    const fu = Math.min(u * (g - 1), g - 1.0001);
    const fv = Math.min(v * (g - 1), g - 1.0001);
    const i = Math.floor(fu);
    const j = Math.floor(fv);
    const su = fu - i;
    const sv = fv - j;
    const a = tile.h[j * g + i];
    const bb = tile.h[j * g + i + 1];
    const c = tile.h[(j + 1) * g + i];
    const d = tile.h[(j + 1) * g + i + 1];
    return (a * (1 - su) + bb * su) * (1 - sv) + (c * (1 - su) + d * su) * sv;
}
