// edit.js — the web GIS editor's policy: what a feature of each kind is, how
// one is read and written through PostgREST, and who may do which.
//
// No DOM and no map, so the parts that are arithmetic are unit-tested in node
// (client/test/edit.test.js) and editui.js owns OpenLayers. Nothing here
// decides who may write: the `write_area` policy of db/0003_rls.sql does
// (Invariant 6), a 403 is that decision arriving, and an `edit` grantee's
// change goes through propose() instead of the table.

import * as api from './api.js';
import { deleteOp, diffOf, insertOp, myAreas, propose, updateOp } from './areas.js';
import { WORLD_SRID } from '../lib/crs.js';
import { tileX, tileY } from '../lib/tilemath.js';

// The five kinds of db/0001_schema.sql's CHECK constraint, each with the
// geometry the drawing tool makes and the props `assemble` actually reads
// (client/lib/props.js, client/lib/terrain.js). A field nobody compiles is a
// field nobody should be asked to fill in.
export const KINDS = {
    road: {
        geometry: 'LineString',
        fields: [{ key: 'width', label: 'width (m)', type: 'number', step: 0.5, value: 5 }],
    },
    forest: {
        geometry: 'Polygon',
        fields: [{ key: 'leaf_type', label: 'leaves', type: 'select',
            options: ['needleleaved', 'broadleaved'], value: 'needleleaved' }],
    },
    water: { geometry: 'Polygon', fields: [] },
    footprint: {
        geometry: 'Polygon',
        fields: [
            { key: 'height', label: 'height (m)', type: 'number', step: 0.5, value: '' },
            { key: 'levels', label: 'levels', type: 'number', step: 1, value: '' },
            { key: 'roof', label: 'roof', type: 'select',
                options: ['flat', 'gabled', 'hipped'], value: 'flat' },
        ],
    },
    terrainmod: {
        geometry: 'Polygon',
        fields: [
            { key: 'op', label: 'operation', type: 'select',
                options: ['flatten', 'raise', 'lower', 'smooth'], value: 'flatten' },
            { key: 'amount', label: 'amount (m)', type: 'number', step: 0.5, value: 0 },
        ],
    },
};

export const KIND_NAMES = Object.keys(KINDS);

export const geometryOf = (kind) => KINDS[kind]?.geometry ?? 'Polygon';

// ------------------------------------------------------------------- props

// What the form makes of what was typed: numbers as numbers, blanks left out
// altogether so a prop the user did not fill in does not override the
// compiler's own default (a footprint with no height is six metres tall).
export function propsFrom(kind, values = {}) {
    const out = {};
    for (const f of KINDS[kind]?.fields ?? []) {
        const raw = values[f.key];
        if (raw === undefined || raw === null || raw === '') continue;
        if (f.type === 'number') {
            const n = Number(raw);
            if (Number.isFinite(n)) out[f.key] = n;
        } else {
            out[f.key] = String(raw);
        }
    }
    return out;
}

// The other direction: a stored row back into the form's boxes.
export function valuesOf(kind, props = {}) {
    const out = {};
    for (const f of KINDS[kind]?.fields ?? []) {
        out[f.key] = props?.[f.key] ?? f.value;
    }
    return out;
}

// --------------------------------------------------------------------- wkt

// feature.geom is geometry(GeometryZ, WORLD_SRID): a 2D geometry is refused outright
// ("Column has Z dimension but geometry does not"), and st_force3d is a
// server-side function that a plain PostgREST insert has no way to call. So
// the height goes on every vertex here, before the row leaves the tab. A
// proposal takes the other road — its geom stays GeoJSON and diff_geom() in
// db/0022_proposals.sql forces it 3D on the way in.
const num = (v) => {
    const s = Number(v).toFixed(9);
    return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

const point = (c, h) => `${num(c[0])} ${num(c[1])} ${num(c[2] ?? h)}`;
const list = (cs, h) => `(${cs.map((c) => point(c, h)).join(', ')})`;
const poly = (rings, h) => `(${rings.map((r) => list(r, h)).join(', ')})`;

export function ewkt(geom, h = 0) {
    const c = geom?.coordinates;
    switch (geom?.type) {
        case 'Point': return `SRID=${WORLD_SRID};POINT Z (${point(c, h)})`;
        case 'LineString': return `SRID=${WORLD_SRID};LINESTRING Z ${list(c, h)}`;
        case 'Polygon': return `SRID=${WORLD_SRID};POLYGON Z ${poly(c, h)}`;
        case 'MultiLineString':
            return `SRID=${WORLD_SRID};MULTILINESTRING Z (${c.map((l) => list(l, h)).join(', ')})`;
        case 'MultiPolygon':
            return `SRID=${WORLD_SRID};MULTIPOLYGON Z (${c.map((p) => poly(p, h)).join(', ')})`;
        default: throw new Error(`no wkt for ${geom?.type ?? 'nothing'}`);
    }
}

// -------------------------------------------------------------------- reads

// PostgREST expresses no spatial predicate, so the tiles under the viewport
// are asked for their world instead: tile_world() (db/0013_world.sql) is the
// same st_intersects the compiler runs, already in GeoJSON, and open to
// everyone. It is the read this editor has; a features-in-a-bbox RPC is what
// it would rather have, and would be one call instead of one per tile.
export const READ_ZOOM = 14;
export const MAX_TILES = 24;

export function tileSpan(bbox, z = READ_ZOOM) {
    const x0 = tileX(bbox.west, z);
    const x1 = tileX(bbox.east, z);
    const y0 = tileY(bbox.north, z);
    const y1 = tileY(bbox.south, z);
    return { z, x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
}

// A view of the whole world is a hundred million z14 tiles, so the span is
// counted before it is enumerated and a view too wide to read returns nothing
// at all. The panel says so; zooming in is the fix.
export function tilesFor(bbox, z = READ_ZOOM, max = MAX_TILES) {
    const s = tileSpan(bbox, z);
    if (s.count > max) return [];
    const out = [];
    for (let x = s.x0; x <= s.x1; x++) {
        for (let y = s.y0; y <= s.y1; y++) out.push({ z, x, y });
    }
    return out;
}

// tile_world() knows every column but area_id, and which area a feature
// belongs to is what says whether it may be edited — so the ids it returns are
// asked about once more. Both calls read what everyone may already read. The
// ids go in `in.()`, which is a URL, so they go a hundred at a time.
const CHUNK = 100;

async function withAreas(byId) {
    const ids = [...byId.keys()];
    for (let i = 0; i < ids.length; i += CHUNK) {
        const rows = await api.select('feature',
            { id: `in.(${ids.slice(i, i + CHUNK).join(',')})`, select: 'id,area_id' });
        for (const r of rows) byId.get(r.id).area_id = r.area_id;
    }
    return [...byId.values()];
}

export async function readFeatures(bbox, { z = READ_ZOOM, max = MAX_TILES } = {}) {
    const span = tileSpan(bbox, z);
    if (span.count > max) return { tiles: span.count, tooWide: true, features: [] };
    const tiles = tilesFor(bbox, z, max);
    const worlds = await Promise.all(tiles.map((t) => api.rpc('tile_world', t)));
    const byId = new Map();
    for (const w of worlds) {
        for (const f of w?.features ?? []) byId.set(f.id, { ...f });
    }
    return { tiles: tiles.length, tooWide: false, features: await withAreas(byId) };
}

// The areas worth drawing: the ones this account may change, and whichever one
// the map is looking at. area_view (db/0021_build.sql) carries the permission
// but only a bounding box, so the polygons come from the table itself.
export async function readAreas(centre) {
    const [mine, here] = await Promise.all([
        myAreas().catch(() => []),
        centre ? api.rpc('area_at', centre).catch(() => []) : [],
    ]);
    const views = new Map();
    for (const a of [...mine, ...here]) views.set(a.id, { ...views.get(a.id), ...a });
    if (!views.size) return [];
    const rows = await api.select('area',
        { id: `in.(${[...views.keys()].join(',')})`, select: 'id,geom' });
    return rows.map((r) => ({ ...views.get(r.id), geom: r.geom }));
}

// --------------------------------------------------------------- permission

// What this account may do here, in one word. The database is still the one
// that decides; this only lets the panel say so first.
export function permissionOf(area) {
    if (!area) return 'none';
    if (area.may_write) return 'write';
    if (area.may_propose) return 'propose';
    return 'read';
}

// ------------------------------------------------------------------- writes

const FIELDS = 'id,area_id,kind,props,rev';

export const createFeature = ({ areaId, kind, geom, props, height = 0 }) =>
    api.insert('feature', [{ area_id: areaId, kind, geom: ewkt(geom, height),
        props: props ?? {} }], { select: FIELDS }).then((rows) => rows[0]);

export function updateFeature(id, { kind, geom, props }, height = 0) {
    const patch = { kind, props };
    if (geom) patch.geom = ewkt(geom, height);
    return api.update('feature', { id: `eq.${id}`, select: FIELDS }, patch)
        .then((rows) => rows[0]);
}

// The world is filtered on deleted_at rather than emptied (db/0013_world.sql),
// and apply_feature_op does the same, so a delete here is an update too — and
// dirties the tiles the feature used to cover, through the same trigger.
export const removeFeature = (id) =>
    api.update('feature', { id: `eq.${id}` }, { deleted_at: new Date().toISOString() });

// A proposer's geometry stays GeoJSON: diff_geom() forces it 3D when the
// proposal merges.
const featureOp = (id, kind, geom, props) => (id
    ? updateOp('feature', id, { kind, geom, props })
    : insertOp('feature', { kind, geom, props }));

// The one entry point the panel uses: write it if the area says so, propose it
// if it only says that, and refuse before the database has to.
export async function saveFeature(area, { id, kind, geom, props, height = 0 }) {
    const may = permissionOf(area);
    if (may === 'write') {
        const row = id
            ? await updateFeature(id, { kind, geom, props }, height)
            : await createFeature({ areaId: area.id, kind, geom, props, height });
        return { mode: 'write', id: row?.id ?? id };
    }
    if (may === 'propose') {
        return { mode: 'propose',
            id: await propose(area.id, diffOf(featureOp(id, kind, geom, props))) };
    }
    throw new Error('you may not edit this area');
}

export async function dropFeature(area, id) {
    const may = permissionOf(area);
    if (may === 'write') {
        await removeFeature(id);
        return { mode: 'write', id };
    }
    if (may === 'propose') {
        return { mode: 'propose', id: await propose(area.id, diffOf(deleteOp('feature', id))) };
    }
    throw new Error('you may not edit this area');
}
