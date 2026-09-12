-- A road drawn in QGIS reaches the world.
--
-- The other gis tests write as the owner of the database, which is nobody. A
-- person drawing connects as their own login (db/0065_playerroles.sql), and
-- the difference is the whole of this bug: what they may draw is decided by
-- the same policies as in the browser. `SET ROLE` is as close as one session
-- gets; db/test/0065_playerroles.sh connects for real.
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

SELECT table_privs_are('public', 'property', 'player', ARRAY['SELECT'],
    'a player may read what a thing may say about itself');
SELECT table_privs_are('public', 'kind', 'player', ARRAY['SELECT'],
    'and what kinds there are');

CREATE TEMP TABLE ids AS
SELECT register('draw@example.com', 'password12') AS owner_id;
GRANT SELECT ON ids TO player;
DELETE FROM ground;
INSERT INTO ground (geoserver_url, coverage, extent, set_by)
SELECT 'http://localhost:8081/geoserver', 'test:ground',
       st_makeenvelope(6.9, 45.9, 7.6, 46.6, world_srid()), ids.owner_id FROM ids;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000e1'::uuid,
       st_geomfromtext('POLYGON((7 46,7.1 46,7.1 46.1,7 46.1,7 46))', world_srid()),
       ids.owner_id, 14
FROM ids;

SET ROLE player;
SELECT set_config('request.jwt.claims',
                  json_build_object('sub', (SELECT owner_id FROM ids),
                                    'role', 'player')::text, true);
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
