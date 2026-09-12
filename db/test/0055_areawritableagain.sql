-- The land layer is written through its trigger, and the trigger fills what a
-- row needs (db/0055_areawritableagain.sql).
--
-- It was about GeoServer's judgement of "read-only", which decided whether it
-- would write to the view at all. Land is assigned now (SPEC §3.2) and QGIS
-- shows it to look at, so what is left is the trigger itself.
BEGIN;
SELECT plan(4);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-00000010a001', 'areaback@example.com', 'x', 'admin');
INSERT INTO account (owner_id) VALUES ('00000000-0000-0000-0000-00000010a001');

SELECT is((SELECT is_updatable FROM information_schema.views
           WHERE table_schema = 'gis' AND table_name = 'area'), 'YES',
          'gis.area is auto-updatable');

-- Nobody is signed in for this one: the owner comes from the world's operator
-- being the only admin, which is what area_defaults falls back to.
SELECT set_config('request.jwt.claims',
                  json_build_object('sub', '00000000-0000-0000-0000-00000010a001',
                                    'role', 'admin')::text, true);

-- A polygon and nothing else.
INSERT INTO gis.area (geom)
VALUES (st_makeenvelope(9.1, 47.1, 9.2, 47.2, 4326));

CREATE TEMP TABLE drawn AS
SELECT * FROM area WHERE st_equals(geom, st_makeenvelope(9.1, 47.1, 9.2, 47.2, 4326));

SELECT is((SELECT count(*)::int FROM drawn), 1, 'the polygon became an area');
SELECT isnt((SELECT owner_id FROM drawn), null,
            'the table trigger fills the owner, as it always did');
SELECT is((SELECT detail FROM drawn), 14::smallint,
          'and a detail nobody typed');

SELECT * FROM finish();
ROLLBACK;
