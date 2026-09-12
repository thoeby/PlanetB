-- Land drawn in QGIS reaches the world (db/0048_groundowner.sql).
--
-- db/test/0046_gisgrants.sql draws a road as the `geoserver` login; this draws
-- the land itself, which since db/0047_landisground.sql writes tiles.
BEGIN;
SELECT plan(3);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role)
VALUES ('00000000-0000-0000-0000-0000000d0001', 'land@example.com', 'x', 'admin');

SET ROLE geoserver;
SELECT lives_ok($$
    INSERT INTO gis.area (geom, detail)
    VALUES (st_envelope(st_buffer(
        tile_bbox(14, tile_x(7.5, 14), tile_y(46.5, 14)), -0.0005)), 14)
$$, 'an area drawn in QGIS is saved');
RESET ROLE;

SELECT is((SELECT count(*)::int FROM area), 1, 'the land is there');
SELECT cmp_ok((SELECT count(*)::int FROM tile WHERE dirty), '>', 0,
    'and its ground is waiting to be compiled');

SELECT * FROM finish();
ROLLBACK;
