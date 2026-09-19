// oldshapes.js — the shapes that used to move the ground, turned into the
// grid that moves it now.
//
// FND.11. A `terrainmod` polygon said flatten, raise, lower or smooth, and the
// compiler did it every time it built the tile. A land carries a grid of
// relative metres since FND.9, and the same shape is a few cells of it. The
// conversion runs in a tab (Invariant 9): the world only says how many are
// left (db/0164).
//
// It is done once. What a shape did and what the grid does are the same
// ground, which client/test/terrainmod.test.js proves to the centimetre.

import * as api from './api.js';
import { Shaping } from './sculpt.js';
import { loadDem, sampleHeight } from '../lib/geo.js';
import { contains } from '../lib/poly.js';
import { MAX_LAT, RAD_PER_DEG } from '../lib/tilemath.js';

// The ground is read at the finest the world is ever cut at, because that is
// what the deepest tile was built on.
const DEM_Z = 18;

const ringsOf = (geom) => {
    if (geom?.type === 'Polygon') return geom.coordinates;
    if (geom?.type === 'MultiPolygon') return geom.coordinates.flat();
    return [];
};

const boxOf = (points) => points.reduce(
    (b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]),
        Math.max(b[2], p[0]), Math.max(b[3], p[1])],
    [180, 90, -180, -90]);

// Where a point falls in its own tile, as Web-Mercator tiles nest: the whole
// number is the tile, the fraction is the place in it.
function atTile(lon, lat, z) {
    const n = 2 ** z;
    const fx = (lon + 180) / 360 * n;
    const phi = Math.min(Math.max(lat, -MAX_LAT), MAX_LAT) * RAD_PER_DEG;
    const fy = (1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * n;
    return { x: Math.floor(fx), y: Math.floor(fy), u: fx % 1, v: fy % 1 };
}

/**
 * The operator's elevation over one box, read the way the compiler reads it —
 * the cut tiles the store serves (client/lib/geo.js).
 *
 * It is not the ground the page is standing on: that one is compiled, and a
 * compiled ground already has both the land's grid and these shapes in it. A
 * land's grid is metres away from the elevation, so the elevation is what the
 * conversion must subtract.
 *
 * @param {number[]} box [west, south, east, north]
 * @param {string} filesUrl where the store is
 * @returns {Promise<function(number, number): number>} metres at lon, lat
 */
export async function demGround(box, filesUrl) {
    const held = new Map();
    const nw = atTile(box[0], box[3], DEM_Z);
    const se = atTile(box[2], box[1], DEM_Z);
    for (let y = nw.y; y <= se.y; y++) {
        for (let x = nw.x; x <= se.x; x++) {
            held.set(`${x}/${y}`,
                await loadDem(DEM_Z, x, y, { filesUrl }).catch(() => null));
        }
    }
    return (lon, lat) => {
        const at = atTile(lon, lat, DEM_Z);
        const dem = held.get(`${at.x}/${at.y}`);
        return dem ? sampleHeight(dem, at.u, at.v) : 0;
    };
}

// The cells of the grid the shape's box covers, so a shape forty metres across
// is not a point-in-polygon test on four million cells.
function span(shaping, box) {
    const [w, s, e, n] = shaping.grid.bbox;
    const at = (v, lo, hi, cells) => Math.min(Math.max(
        Math.floor((v - lo) / (hi - lo) * (cells - 1)), 0), cells - 1);
    return {
        i0: at(box[0], w, e, shaping.grid.width),
        i1: at(box[2], w, e, shaping.grid.width) + 1,
        j0: at(box[3], n, s, shaping.grid.height),
        j1: at(box[1], n, s, shaping.grid.height) + 1,
    };
}

// What one shape does to the ground, as metres away from what the elevation
// says: the heights client/lib/terrain.js's applyTerrainmods wrote, less the
// elevation underneath them. `at` is what the land already says, because a
// shape flattened the ground the land's own grid had already moved.
function intoGrid(shaping, shape, dem) {
    const rings = ringsOf(shape.geom);
    const points = rings.flat();
    if (!points.length) return 0;
    const op = String(shape.props?.op ?? 'flatten').toLowerCase();
    const amount = Number(shape.props?.amount ?? 0) || 0;
    const at = (lon, lat) => dem(lon, lat) + shaping.at(lon, lat);
    const level = points.reduce((s, p) => s + at(p[0], p[1]), 0) / points.length;
    const { i0, i1, j0, j1 } = span(shaping, boxOf(points));
    let moved = 0;
    for (let j = j0; j < j1; j++) {
        for (let i = i0; i < i1; i++) {
            const lon = shaping.lonOf(i);
            const lat = shaping.latOf(j);
            if (!contains(rings, lon, lat)) continue;
            const k = j * shaping.grid.width + i;
            shaping.remember(k);
            shaping.grid.data[k] = wrote(op, amount, level, at(lon, lat))
                - dem(lon, lat);
            moved += 1;
        }
    }
    return moved;
}

// The height applyTerrainmods left at one cell. `smooth` averaged the eight
// cells around it in the tile's own grid, which was between thirty metres and
// twenty centimetres wide depending on the tile: a resolution a land's grid
// does not have, so what is kept of it is the ground it was smoothing.
const wrote = (op, amount, level, was) => {
    if (op === 'raise') return was + amount;
    if (op === 'lower') return was - amount;
    if (op === 'flatten') return level + amount;
    return was;
};

/** How many old shapes there are, and on which lands. */
export const oldShapes = () => api.rpc('old_shapes').catch(() => null);

/**
 * One land's shapes, into its grid and then out of the world.
 *
 * The grid it is merged into is whatever the land already has, so a land that
 * was shaped in the page keeps that shaping and gains this.
 */
export async function convertLand(area) {
    const shapes = await api.rpc('area_shapes', { area: area.id }).catch(() => []);
    if (!shapes?.length) return { shapes: 0, cells: 0 };
    const shaping = await Shaping.load(area);
    const box = boxOf(shapes.flatMap((s) => ringsOf(s.geom).flat()));
    const dem = await demGround(box, api.endpoints().files);
    shaping.begin();
    let cells = 0;
    for (const shape of shapes) cells += intoGrid(shaping, shape, dem);
    shaping.mark(shaping.stroke ?? new Map());
    shaping.end();
    if (cells) await shaping.save();
    const retired = await api.rpc('retire_shapes', { area: area.id });
    return { shapes: shapes.length, cells, retired };
}

/**
 * Every land with old shapes on it, one after another, and then the kind
 * itself: once nothing is left to convert there is nothing for it to be
 * (db/0165).
 */
export async function convertAll() {
    const said = await oldShapes();
    const out = { lands: 0, shapes: 0 };
    for (const land of said?.lands ?? []) {
        const got = await convertLand(land);
        out.lands += 1;
        out.shapes += got.shapes;
    }
    out.retired = Boolean((await api.rpc('retire_shape_kind')).retired);
    return out;
}
