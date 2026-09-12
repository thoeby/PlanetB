-- Drawing land in QGIS, which sends a multi-part polygon for any polygon
-- layer (db/0057_areamultipart.sql). Every feature drawn afterwards depends on
-- an area existing, so this is the first thing that has to work.
BEGIN;
SELECT plan(10);

INSERT INTO auth.user (email, pw_hash, role) VALUES ('draw57@example.com', 'x', 'admin');

-- Declared multi, so that is what GeoServer publishes and QGIS is offered.
SELECT is(
    (SELECT type::text FROM geometry_columns
     WHERE f_table_schema = 'gis' AND f_table_name = 'area'),
    'MULTIPOLYGON', 'gis.area is declared multi-part');
SELECT has_trigger('gis', 'area', 'gis_area_write',
                   'and is written through an INSTEAD OF trigger');
-- Without this row GeoServer cannot key the layer and serves it read-only,
-- which is what got the same fix reverted in db/0055.
SELECT is(
    (SELECT count(*)::int FROM gis.gt_pk_metadata
     WHERE table_schema = 'gis' AND table_name = 'area' AND pk_column = 'id'),
    1, 'and its primary key is registered for GeoServer');

-- A Save from QGIS: a multipolygon of one part, detail left blank.
INSERT INTO gis.area (geom, detail) VALUES
    (st_geomfromtext('MULTIPOLYGON(((7 46, 7.1 46, 7.1 46.1, 7 46.1, 7 46)))', 4326), 0);
SELECT is((SELECT st_geometrytype(geom) FROM area), 'ST_Polygon',
          'the single part is unwrapped: what is stored is still one ring');
SELECT is((SELECT (detail, owner_id = gis.default_owner()) FROM area),
          (14::smallint, true),
          'a blank detail is still the baseline, and the admin still owns it');

-- Two rings is a mistake worth naming rather than half-saving.
SELECT throws_like(
    $$INSERT INTO gis.area (geom, detail) VALUES (st_geomfromtext(
        'MULTIPOLYGON(((8 46, 8.1 46, 8.1 46.1, 8 46)),((8.2 46, 8.3 46, 8.3 46.1, 8.2 46)))',
        4326), 0)$$,
    '%an area is one ring, and this one has 2%',
    'an area of two rings says which it is and how many');

-- And what the whole chain was failing on: a feature drawn inside that land.
INSERT INTO gis.f_water (geom) VALUES
    (st_geomfromtext('MULTIPOLYGON(((7.01 46.01, 7.02 46.01, 7.02 46.02, 7.01 46.01)))', 4326));
SELECT is((SELECT (kind, area_id IS NOT null) FROM feature),
          ('water'::text, true),
          'water drawn inside it finds the area, which is what the error was');

-- Moving and deleting the land go through the same trigger.
UPDATE gis.area SET geom = st_geomfromtext(
    'MULTIPOLYGON(((7 46, 7.2 46, 7.2 46.1, 7 46.1, 7 46)))', 4326);
SELECT is((SELECT round(st_xmax(geom)::numeric, 2) FROM area), 7.20,
          'moving the land moves the area');
UPDATE gis.area SET detail = 12;
SELECT is((SELECT detail FROM area), 12::smallint,
          'and changing only the detail leaves the geometry alone');

DELETE FROM feature;
DELETE FROM gis.area;
SELECT is((SELECT count(*) FROM area), 0::bigint,
          'deleting through the layer deletes the area');

SELECT * FROM finish();
ROLLBACK;
