-- Land reaches the world, and the ground under it becomes tiles
-- (db/0048_groundowner.sql).
--
-- It drew the land itself as the `geoserver` login, because that is how land
-- was made. Land is assigned by an admin now (SPEC §3.2, db/0063), and what
-- this still has to show is what having land does to the tiles under it: they
-- exist, and none of them is waiting (db/0064).
BEGIN;
SELECT plan(4);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role)
VALUES ('00000000-0000-0000-0000-0000000d0001', 'land@example.com', 'x', 'admin');

SELECT lives_ok($$
    INSERT INTO area (geom, owner_id, detail)
    VALUES (st_envelope(st_buffer(
        tile_bbox(14, tile_x(7.5, 14), tile_y(46.5, 14)), -0.0005)),
        '00000000-0000-0000-0000-0000000d0001', 14)
$$, 'land assigned to somebody is saved');

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
