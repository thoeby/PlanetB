-- Land drawn in QGIS reaches the world (db/0048_groundowner.sql).
--
-- db/test/0046_gisgrants.sql draws a road as the `geoserver` login; this draws
-- the land itself, which since db/0047_landisground.sql writes tiles — and
-- since db/0064 writes them clean.
BEGIN;
SELECT plan(4);

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
-- The tiles exist — they are what a compile attaches to — and none of them is
-- waiting, because claiming land renders nothing (SPEC §3.2,
-- db/0064_claimingrendersnothing.sql).
SELECT cmp_ok((SELECT count(*)::int FROM tile), '>', 0,
    'and its ground is a tile');
SELECT is((SELECT count(*)::int FROM tile WHERE dirty), 0,
    'which is waiting for nothing');

SELECT * FROM finish();
ROLLBACK;
