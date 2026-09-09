// WP5.3 — the parts of the web GIS editor that are arithmetic: what a kind of
// feature is, what its form makes of what was typed, and the WKT a drawn
// geometry becomes on its way into a GeometryZ column.
//
// The map itself is client/test/e2e/edit.spec.js, which draws with the mouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KINDS, KIND_NAMES, MAX_TILES, ewkt, geometryOf, permissionOf, propsFrom,
    tileSpan, tilesFor, valuesOf } from '../js/edit.js';
import { tileX, tileY } from '../lib/tilemath.js';

// db/0001_schema.sql's CHECK constraint, in its own order. A kind the editor
// offers that the database refuses is a 400 nobody can act on.
const SCHEMA_KINDS = ['road', 'forest', 'water', 'footprint', 'terrainmod'];

test('the editor offers exactly the kinds the schema allows', () => {
    assert.deepEqual(KIND_NAMES, SCHEMA_KINDS);
    for (const kind of SCHEMA_KINDS) {
        assert.ok(['Polygon', 'LineString'].includes(geometryOf(kind)),
            `${kind} draws something OpenLayers can make`);
    }
    assert.equal(geometryOf('road'), 'LineString', 'a road is a centreline');
    assert.equal(geometryOf('forest'), 'Polygon');
});

// ------------------------------------------------------------------- props

test('the form only produces props the compiler reads', () => {
    for (const [kind, spec] of Object.entries(KINDS)) {
        for (const f of spec.fields) {
            assert.ok(f.key && f.label, `${kind}.${f.key} is a field with a label`);
            if (f.type === 'select') assert.ok(f.options.length > 1);
        }
    }
    // client/lib/props.js reads these two off a footprint and nothing else.
    assert.deepEqual(KINDS.footprint.fields.map((f) => f.key).sort(),
        ['height', 'levels', 'roof']);
    assert.deepEqual(KINDS.terrainmod.fields.map((f) => f.key), ['op', 'amount']);
});

test('a number typed into a box comes out a number', () => {
    assert.deepEqual(propsFrom('road', { width: '7.5' }), { width: 7.5 });
    assert.deepEqual(propsFrom('terrainmod', { op: 'raise', amount: '3' }),
        { op: 'raise', amount: 3 });
});

test('a box nobody filled in leaves no prop behind', () => {
    // A footprint with no height is six metres tall (client/lib/props.js); an
    // empty box must not overwrite that with a zero or a NaN.
    assert.deepEqual(propsFrom('footprint', { height: '', levels: '', roof: 'gabled' }),
        { roof: 'gabled' });
    assert.deepEqual(propsFrom('footprint', { height: 'tall' }), {});
    assert.deepEqual(propsFrom('water', { width: '3' }), {},
        'a prop no field names is not written');
});

test('an existing row fills the form, and the defaults fill the rest', () => {
    assert.deepEqual(valuesOf('forest', { leaf_type: 'broadleaved' }),
        { leaf_type: 'broadleaved' });
    assert.deepEqual(valuesOf('forest', {}), { leaf_type: 'needleleaved' });
    assert.deepEqual(valuesOf('road', null), { width: 5 });
});

// --------------------------------------------------------------------- wkt

test('a drawn polygon becomes 3D EWKT, because the column is GeometryZ', () => {
    const ring = [[8.1, 47.4], [8.2, 47.4], [8.2, 47.5], [8.1, 47.4]];
    assert.equal(ewkt({ type: 'Polygon', coordinates: [ring] }),
        'SRID=4326;POLYGON Z ((8.1 47.4 0, 8.2 47.4 0, 8.2 47.5 0, 8.1 47.4 0))');
});

test('a height given is a height kept, and one already on a vertex wins', () => {
    assert.equal(ewkt({ type: 'LineString', coordinates: [[8.1, 47.4], [8.2, 47.5]] }, 12),
        'SRID=4326;LINESTRING Z (8.1 47.4 12, 8.2 47.5 12)');
    assert.equal(ewkt({ type: 'LineString', coordinates: [[8.1, 47.4, 3], [8.2, 47.5]] }, 12),
        'SRID=4326;LINESTRING Z (8.1 47.4 3, 8.2 47.5 12)');
});

test('the multi geometries and points carry their Z too', () => {
    assert.equal(ewkt({ type: 'Point', coordinates: [8.1, 47.4] }),
        'SRID=4326;POINT Z (8.1 47.4 0)');
    assert.equal(ewkt({ type: 'MultiLineString',
        coordinates: [[[8, 47], [8.1, 47]], [[8.2, 47], [8.3, 47]]] }),
    'SRID=4326;MULTILINESTRING Z ((8 47 0, 8.1 47 0), (8.2 47 0, 8.3 47 0))');
    const ring = [[8, 47], [8.1, 47], [8.1, 47.1], [8, 47]];
    assert.equal(ewkt({ type: 'MultiPolygon', coordinates: [[ring]] }),
        'SRID=4326;MULTIPOLYGON Z (((8 47 0, 8.1 47 0, 8.1 47.1 0, 8 47 0)))');
});

// A coordinate that reaches WKT in exponent form ("1e-7") or with sixteen
// digits of float noise is a geometry that reads back as something else.
test('coordinates are written as plain decimals', () => {
    const wkt = ewkt({ type: 'Point', coordinates: [0.1 + 0.2, 1e-7] });
    assert.equal(wkt, 'SRID=4326;POINT Z (0.3 0.0000001 0)');
    assert.ok(!/e[-+]/i.test(wkt), 'no exponents');
});

test('a geometry nothing drew is refused rather than sent', () => {
    assert.throws(() => ewkt(null), /no wkt/);
    assert.throws(() => ewkt({ type: 'GeometryCollection', geometries: [] }), /no wkt/);
});

// ------------------------------------------------------- viewport and rights

test('the viewport asks the tiles under it, and no others', () => {
    const z = 14;
    const one = tilesFor({ west: 8.0, south: 47.4, east: 8.001, north: 47.401 }, z);
    assert.deepEqual(one, [{ z, x: tileX(8.0, z), y: tileY(47.4, z) }]);

    const bbox = { west: 8.0, south: 47.4, east: 8.1, north: 47.5 };
    const wide = tileX(8.1, z) - tileX(8.0, z) + 1;
    const tall = tileY(47.4, z) - tileY(47.5, z) + 1;
    assert.equal(tileSpan(bbox, z).count, wide * tall);
    const many = tilesFor(bbox, z, wide * tall);
    assert.equal(many.length, wide * tall);
    assert.ok(many.every((t) => t.z === z));
    assert.ok(many.some((t) => t.x === tileX(8.1, z) && t.y === tileY(47.4, z)),
        'the far corner is in there');
});

// The map opens on the whole world, which is 268 million z14 tiles. Counting
// them is arithmetic; enumerating them would hang the tab.
test('a view too wide to read is counted, never enumerated', () => {
    const world = { west: -180, south: -85, east: 180, north: 85 };
    assert.ok(tileSpan(world).count > 1e8);
    assert.deepEqual(tilesFor(world), []);
    assert.ok(MAX_TILES > 0 && MAX_TILES < 100);
});

test('what this account may do here is one word', () => {
    assert.equal(permissionOf({ may_write: true, may_propose: true }), 'write');
    assert.equal(permissionOf({ may_write: false, may_propose: true }), 'propose');
    assert.equal(permissionOf({ may_write: false, may_propose: false }), 'read');
    assert.equal(permissionOf(null), 'none');
});
