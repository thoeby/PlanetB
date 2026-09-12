-- A road drawn in QGIS reaches the world.
--
-- The other gis tests write as the owner of the database, which is nobody:
-- GeoServer connects as the `geoserver` login, and the difference is the whole
-- of this bug. This one draws as that role.
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

SELECT table_privs_are('public', 'property', 'geoserver', ARRAY['SELECT'],
    'the drawing role may read what a thing may say about itself');
SELECT table_privs_are('public', 'kind', 'geoserver', ARRAY['SELECT'],
    'and what kinds there are');

CREATE TEMP TABLE ids AS
SELECT register('draw@example.com', 'password12') AS owner_id;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000e1'::uuid,
       st_geomfromtext('POLYGON((7 46,7.1 46,7.1 46.1,7 46.1,7 46))', 4326),
       ids.owner_id, 14
FROM ids;

SET ROLE geoserver;
SELECT lives_ok($$
    INSERT INTO gis.f_road (geom)
    VALUES (st_geomfromtext('LINESTRING(7.01 46.01, 7.02 46.02)', 4326))
$$, 'a road drawn in QGIS is saved');
SELECT lives_ok($$
    INSERT INTO gis.f_forest (geom, leaf_type)
    VALUES (st_geomfromtext(
        'POLYGON((7.02 46.02,7.03 46.02,7.03 46.03,7.02 46.03,7.02 46.02))', 4326),
        'broadleaved')
$$, 'and so is a wood with a property filled in');
RESET ROLE;

SELECT is((SELECT array_agg(kind ORDER BY kind) FROM feature), ARRAY['forest', 'road'],
    'both landed on the right kind');
SELECT is((SELECT props ->> 'leaf_type' FROM feature WHERE kind = 'forest'),
    'broadleaved', 'with what the form said');

SELECT * FROM finish();
ROLLBACK;
