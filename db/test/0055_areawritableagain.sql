-- The layer QGIS draws land on is auto-updatable, which is what decides
-- whether GeoServer will write to it at all (db/0055_areawritableagain.sql).
BEGIN;
SELECT plan(4);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-00000010a001', 'areaback@example.com', 'x', 'admin');
INSERT INTO account (owner_id) VALUES ('00000000-0000-0000-0000-00000010a001');

-- The property GeoTools reads to decide "read-only". An INSTEAD OF trigger
-- sets it to NO, which is how db/0054 broke drawing.
SELECT is((SELECT is_updatable FROM information_schema.views
           WHERE table_schema = 'gis' AND table_name = 'area'), 'YES',
          'gis.area is auto-updatable, so GeoServer will write to it');

-- And what QGIS sends: a polygon and nothing else.
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
