#!/usr/bin/env node
// Imports your own map layers into the world:
//
//     node tools/import-layers.mjs my-region.json
//
// A layer comes either from a GeoServer (WFS GetFeature hands back GeoJSON over
// plain HTTP — no GDAL, no shapefile reader, nothing to install) or from a
// .geojson file. You say which layer is which kind and which attribute is which
// property; this writes the `area` rows for the region and the `feature` rows
// the compiler already knows how to turn into terrain.
//
// The five kinds the world understands, and what they read:
//
//     footprint   polygon   props.height  (metres)
//     road        line      props.width   (metres)
//     forest      polygon   —
//     water       polygon   —
//     terrainmod  polygon   —
//
// Geometry goes in flat: the world stores plan geometry at Z = 0 and takes the
// ground height from the DEM when the tile is compiled, exactly as seed-osm
// does. Re-running skips features it already imported (props.src).
//
// Dev-box tooling: it writes rows and computes nothing about the world
// (Invariant 9). See docs/import.md for the config file.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { tileX, tileY } from '../client/lib/tilemath.js';

const KINDS = ['road', 'forest', 'water', 'footprint', 'terrainmod'];
const AREA_ZOOM = 12;

const die = (msg) => { console.error(`import: ${msg}`); process.exit(1); };
// Everything else reaches SQL as jsonb through \copy; these two are the only
// values interpolated into the statement, so they are quoted here.
const q = (v) => String(v).replaceAll("'", "''");

const cfgPath = process.argv[2] ?? die('usage: import-layers.mjs <config.json>');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const cfgDir = dirname(resolve(cfgPath));

const owner = cfg.owner?.email ?? 'me@splatworld.local';
const ownerPw = cfg.owner?.password ?? 'change-me';
const detail = cfg.detail ?? 14;
if (!Array.isArray(cfg.layers) || !cfg.layers.length) die('config has no "layers"');

// ------------------------------------------------------------------ sources

// WFS 2.0 with a JSON output format. srsName pins lon/lat order to what
// GeoJSON means by it, which is the one thing WFS servers disagree about.
function wfsUrl(layer) {
    const u = new URL(layer.wfs);
    const q = {
        service: 'WFS', version: '2.0.0', request: 'GetFeature',
        typeNames: layer.typeName ?? die(`layer "${layer.name}" has no "typeName"`),
        outputFormat: 'application/json', srsName: 'EPSG:4326',
        ...(layer.count ? { count: String(layer.count) } : {}),
    };
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return u.toString();
}

async function load(layer) {
    if (layer.file) return JSON.parse(readFileSync(resolve(cfgDir, layer.file), 'utf8'));
    if (!layer.wfs) die(`layer "${layer.name}" has neither "wfs" nor "file"`);
    const url = wfsUrl(layer);
    const creds = `${layer.user}:${layer.password ?? ''}`;
    const headers = layer.user
        ? { authorization: `Basic ${Buffer.from(creds).toString('base64')}` }
        : {};
    const res = await fetch(url, { headers });
    if (!res.ok) die(`${layer.name}: ${res.status} ${res.statusText} from ${url}`);
    const body = await res.text();
    try {
        return JSON.parse(body);
    } catch {
        // GeoServer answers a bad request with an XML ServiceException, not JSON.
        die(`${layer.name}: server did not return GeoJSON — ${body.slice(0, 300)}`);
    }
    return null;
}

// ------------------------------------------------------------- normalisation

const num = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(String(v).replace(',', '.').replace(/[^0-9.eE+-]/g, ''));
    return Number.isFinite(n) ? n : null;
};

// props: { height: "bldg_hoehe" } renames one attribute and keeps it numeric,
// because every property the compiler reads is a length in metres.
function propsOf(layer, attrs) {
    const out = {};
    for (const [want, from] of Object.entries(layer.props ?? {})) {
        const v = num(attrs?.[from]);
        if (v !== null) out[want] = v;
    }
    for (const k of layer.keep ?? []) {
        if (attrs?.[k] !== undefined && attrs?.[k] !== null) out[k] = attrs[k];
    }
    return out;
}

function rowsOf(layer, geojson, index) {
    const feats = geojson?.features ?? (geojson?.type === 'Feature' ? [geojson] : []);
    if (!feats.length) console.warn(`import: ${layer.name} returned no features`);
    return feats.flatMap((f, i) => {
        if (!f?.geometry) return [];
        const id = f.id ?? f.properties?.[layer.idField] ?? `${index}-${i}`;
        return [{
            src: `${layer.name}:${id}`,
            kind: layer.kind,
            props: propsOf(layer, f.properties),
            geom: f.geometry,
        }];
    });
}

// ----------------------------------------------------------------- the region

function bboxOf(rows) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (c) => {
        if (typeof c[0] === 'number') {
            b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]);
            b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
        } else for (const p of c) walk(p);
    };
    for (const r of rows) if (r.geom?.coordinates) walk(r.geom.coordinates);
    return b;
}

// One area per z12 tile the region touches, like seed-osm: an area is the unit
// of ownership, and tiles finer than `detail` are never compiled inside it.
function areaTiles([w, s, e, n]) {
    const out = [];
    for (let x = tileX(w, AREA_ZOOM); x <= tileX(e, AREA_ZOOM); x += 1) {
        for (let y = tileY(n, AREA_ZOOM); y <= tileY(s, AREA_ZOOM); y += 1) {
            out.push({ x, y });
        }
    }
    return out;
}

// ---------------------------------------------------------------------- run

const rows = [];
for (const [i, layer] of cfg.layers.entries()) {
    layer.name = layer.name ?? layer.typeName ?? `layer${i}`;
    if (!KINDS.includes(layer.kind)) {
        die(`layer "${layer.name}": kind must be one of ${KINDS.join(', ')}`);
    }
    const got = rowsOf(layer, await load(layer), i);
    console.log(`import: ${layer.name} → ${got.length} ${layer.kind}`);
    rows.push(...got);
}
if (!rows.length) die('no features in any layer');

const bbox = cfg.bbox ?? bboxOf(rows);
if (!bbox.every(Number.isFinite)) die('could not work out a region — give "bbox"');
const tiles = areaTiles(bbox);
console.log(`import: region ${bbox.map((v) => v.toFixed(4)).join(', ')}`
    + ` → ${tiles.length} area(s) at z${AREA_ZOOM}, detail z${detail}`);

// CSV rather than inline SQL: one quoted column of JSON per row, so no geometry
// or attribute value can break out into the statement around it.
const work = mkdtempSync(join(tmpdir(), 'splat-import-'));
const csv = join(work, 'rows.csv');
writeFileSync(csv, `${rows
    .map((r) => `"${JSON.stringify(r).replaceAll('"', '""')}"`)
    .join('\n')}\n`);

const sql = join(work, 'import.sql');
writeFileSync(sql, `
\\set ON_ERROR_STOP on
CREATE SCHEMA IF NOT EXISTS seed;
DROP TABLE IF EXISTS seed.import_raw;
CREATE TABLE seed.import_raw (doc jsonb);
\\copy seed.import_raw (doc) FROM '${csv}' WITH (FORMAT csv)

DO $import$
DECLARE
    uid uuid;
    n   int;
BEGIN
    SELECT id INTO uid FROM auth.user WHERE email = '${q(owner)}';
    IF uid IS NULL THEN uid := register('${q(owner)}', '${q(ownerPw)}'); END IF;
    UPDATE auth.user SET role = 'admin' WHERE id = uid;

    INSERT INTO area (geom, owner_id, detail, rules)
    SELECT tile_bbox(${AREA_ZOOM}, t.x, t.y), uid, ${detail},
           jsonb_build_object('src', 'import', 'z12', t.x || '/' || t.y)
    FROM (VALUES ${tiles.map((t) => `(${t.x},${t.y})`).join(',')}) AS t (x, y)
    WHERE NOT EXISTS (
        SELECT 1 FROM area a
        WHERE a.owner_id = uid AND a.rules ->> 'z12' = t.x || '/' || t.y);

    -- Flat, valid, and inside an area you own. Z = 0: the ground height is the
    -- DEM's job at compile time, same as tools/seed-osm.sh.
    INSERT INTO feature (area_id, kind, geom, props)
    SELECT a.id, r.doc ->> 'kind',
           st_force3d(st_makevalid(st_setsrid(st_geomfromgeojson(r.doc -> 'geom'), 4326))),
           (r.doc -> 'props') || jsonb_build_object('src', r.doc ->> 'src')
    FROM seed.import_raw r
    JOIN area a ON a.owner_id = uid
        AND st_intersects(a.geom, st_pointonsurface(
            st_makevalid(st_setsrid(st_geomfromgeojson(r.doc -> 'geom'), 4326))))
    WHERE st_isvalid(st_makevalid(st_setsrid(st_geomfromgeojson(r.doc -> 'geom'), 4326)))
      AND NOT EXISTS (SELECT 1 FROM feature f
                      WHERE f.props ->> 'src' = r.doc ->> 'src');
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'import: % features inserted', n;
END
$import$;

DROP TABLE IF EXISTS seed.import_raw;
SELECT 'import: ' || count(*) || ' features now, ' ||
       (SELECT count(*) FROM tile WHERE dirty) || ' tiles waiting to compile'
FROM feature WHERE props ? 'src';
`);

execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-q', '-f', sql],
    { stdio: 'inherit' });
console.log(`import: signed-in owner is ${owner}`);
