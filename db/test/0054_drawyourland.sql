-- Drawing a polygon on "Your land" makes an area, owner and all
-- (db/0054_drawyourland.sql).
BEGIN;
SELECT plan(5);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-0000000f1001', 'drawland@example.com', 'x', 'admin');
INSERT INTO account (owner_id) VALUES ('00000000-0000-0000-0000-0000000f1001');

-- What QGIS sends: geometry and nothing else, multipart, through the view.
INSERT INTO gis.area (geom) VALUES (
    st_multi(st_makeenvelope(7.8, 46.2, 7.9, 46.3, 4326)));

-- Scoped to the ground just drawn: other tests and the seed leave areas of
-- their own here, and the owner filled in is the world's first admin, who is
-- not necessarily the user this test made.
CREATE TEMP TABLE drawn AS
SELECT * FROM area WHERE st_equals(geom, st_makeenvelope(7.8, 46.2, 7.9, 46.3, 4326));

SELECT is((SELECT count(*)::int FROM drawn), 1, 'the polygon became an area');
SELECT isnt((SELECT owner_id FROM drawn), null,
            'with an owner, which the drawer never types');
SELECT is((SELECT detail FROM drawn), 14::smallint, 'and the default detail');
SELECT is((SELECT st_geometrytype(geom) FROM drawn), 'ST_Polygon',
          'a one-part multipolygon is stored as the polygon it is');

UPDATE gis.area SET detail = 12 WHERE id = (SELECT id FROM drawn);
SELECT is((SELECT detail FROM area WHERE id = (SELECT id FROM drawn)),
          12::smallint, 'and the detail can be changed from the layer');

SELECT * FROM finish();
ROLLBACK;
