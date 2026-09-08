#!/usr/bin/env node
// tilemath-fixtures.mjs — exports the fixture client/test/tilemath.test.js
// checks client/lib/tilemath.js against. The rows come out of the database, so
// this needs a migrated $PGDATABASE (make db-reset). Regenerate with:
//
//     set -a; . ./.env; set +a; node tools/tilemath-fixtures.mjs
//
// psql is given no connection flags on purpose: it reads the same PG* variables
// the Makefile exports, so the fixture always comes from the gate's database.
//
// The geometries are seeded, so the file only changes when the SQL does.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = 'client/test/fixtures/tilemath.json';
const N = 50;

// mulberry32: 32 bits of state, same numbers on every machine.
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const round = (v) => Math.round(v * 1e9) / 1e9;

// Geometry extent scaled to the finest zoom asked for, so a z18 case does not
// enumerate a continent.
function makeGeom(r, kind, maxZ) {
    const span = 360 / 2 ** maxZ * 3;
    const lon = round(-175 + r() * 350);
    const lat = round(-80 + r() * 160);
    const p = (i, j) => [round(lon + i * span), round(lat + j * span)];
    const z = () => round(r() * 2000);
    switch (kind) {
        case 'Point':
            return { type: 'Point', coordinates: [lon, lat] };
        case 'PointZ':
            return { type: 'Point', coordinates: [lon, lat, z()] };
        case 'LineString':
            return { type: 'LineString', coordinates: [p(0, 0), p(1, 0.4), p(1.6, 1.2)] };
        case 'LineStringZ':
            return {
                type: 'LineString',
                coordinates: [[...p(0, 0), z()], [...p(-1, 0.7), z()], [...p(0.5, 1.4), z()]],
            };
        case 'Polygon':
            return {
                type: 'Polygon',
                coordinates: [[p(0, 0), p(2, 0), p(2, 2), p(0, 2), p(0, 0)]],
            };
        case 'PolygonHole':
            return {
                type: 'Polygon',
                coordinates: [
                    [p(0, 0), p(4, 0), p(4, 4), p(0, 4), p(0, 0)],
                    [p(1, 1), p(1, 3), p(3, 3), p(3, 1), p(1, 1)],
                ],
            };
        default:
            throw new Error(kind);
    }
}

const firstCoord = (c) => (typeof c[0] === 'number' ? c : firstCoord(c[0]));

function wkt(g) {
    const dim = firstCoord(g.coordinates).length === 3 ? ' Z ' : ' ';
    const pt = (c) => c.join(' ');
    const ring = (cs) => `(${cs.map(pt).join(', ')})`;
    if (g.type === 'Point') return `POINT${dim}(${pt(g.coordinates)})`;
    if (g.type === 'LineString') return `LINESTRING${dim}${ring(g.coordinates)}`;
    return `POLYGON${dim}(${g.coordinates.map(ring).join(', ')})`;
}

const KINDS = ['Point', 'PointZ', 'LineString', 'LineStringZ', 'Polygon', 'PolygonHole'];
const RANGES = [[6, 18], [6, 14], [10, 18], [12, 16], [14, 14], [6, 10], [16, 18]];

const r = rng(20260908);
const cases = [];
for (let i = 0; i < N; i++) {
    const [minZ, maxZ] = RANGES[i % RANGES.length];
    const kind = KINDS[i % KINDS.length];
    const geom = makeGeom(r, kind, maxZ);
    cases.push({ i, kind, minZ, maxZ, geom, wkt: wkt(geom) });
}

// Probe points for tile_x / tile_y / tile_bbox, including both Mercator poles.
const probes = [];
for (let i = 0; i < 24; i++) {
    probes.push({
        lon: round(-180 + r() * 360),
        lat: round(-89 + r() * 178),
        z: [6, 8, 10, 12, 14, 16, 18][i % 7],
    });
}

const lit = (s) => `'${s.replaceAll("'", "''")}'`;
const values = cases.map((c) =>
    `(${c.i}, ${lit(c.wkt)}, ${c.minZ}, ${c.maxZ})`).join(',\n    ');
const probeValues = probes.map((p, i) =>
    `(${i}, ${p.lon}::float8, ${p.lat}::float8, ${p.z})`).join(',\n    ');

const sql = `
\\set QUIET on
\\pset tuples_only on
\\pset format unaligned
WITH g (i, wkt, minz, maxz) AS (VALUES
    ${values}
),
p (i, lon, lat, z) AS (VALUES
    ${probeValues}
)
SELECT jsonb_pretty(jsonb_build_object(
    'tiles', (SELECT jsonb_agg(jsonb_build_object('i', g.i, 'rows', (
            SELECT coalesce(jsonb_agg(
                jsonb_build_array(t.z, t.x, t.y) ORDER BY t.z, t.x, t.y), '[]')
            FROM tiles_for_geom(st_geomfromtext(g.wkt, 4326), g.minz, g.maxz) AS t
        )) ORDER BY g.i) FROM g),
    'probes', (SELECT jsonb_agg(jsonb_build_object(
            'i', p.i,
            'x', tile_x(p.lon, p.z), 'y', tile_y(p.lat, p.z),
            'bbox', jsonb_build_array(
                st_xmin(tile_bbox(p.z, tile_x(p.lon, p.z), tile_y(p.lat, p.z))),
                st_ymin(tile_bbox(p.z, tile_x(p.lon, p.z), tile_y(p.lat, p.z))),
                st_xmax(tile_bbox(p.z, tile_x(p.lon, p.z), tile_y(p.lat, p.z))),
                st_ymax(tile_bbox(p.z, tile_x(p.lon, p.z), tile_y(p.lat, p.z))))
        ) ORDER BY p.i) FROM p)
));
`;

const dir = mkdtempSync(join(tmpdir(), 'tilemath-'));
const file = join(dir, 'q.sql');
writeFileSync(file, sql);
const out = execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-f', file],
    { encoding: 'utf8', env: process.env });
const db = JSON.parse(out);

const byCase = new Map(db.tiles.map((t) => [t.i, t.rows]));
const byProbe = new Map(db.probes.map((t) => [t.i, t]));

const fixture = {
    source: 'db/0004_tiles.sql via tools/tilemath-fixtures.mjs',
    seed: 20260908,
    cases: cases.map((c) => ({ ...c, tiles: byCase.get(c.i) })),
    probes: probes.map((p, i) => ({
        ...p,
        x: byProbe.get(i).x,
        y: byProbe.get(i).y,
        bbox: byProbe.get(i).bbox,
    })),
};
writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
const rows = fixture.cases.reduce((n, c) => n + c.tiles.length, 0);
console.log(`${OUT}: ${fixture.cases.length} cases, ${rows} tile rows, ${probes.length} probes`);
