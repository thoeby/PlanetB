-- WP0.5 acceptance: a feature in a detail-14 area bumps exactly the 5 tiles
-- (z6…z14) that contain it; two edits bump by 2; an edit outside any area raises.
--
-- The two areas are one tile of their own detail wide, inset so they touch no
-- neighbour. They used to be a fifth of a degree, because claiming land created
-- no tiles at all; since db/0047_landisground.sql land is ground, and an area
-- of that size would make hundreds of tiles that have nothing to do with what
-- is being tested here. Claiming the land is itself the first edit, which is
-- why the versions below start where they do.
BEGIN;
SELECT plan(26);

SELECT has_function('public', 'tiles_for_geom',
    ARRAY['geometry', 'integer', 'integer'], 'tiles_for_geom()');
SELECT has_function('public', 'tile_bbox',
    ARRAY['integer', 'integer', 'integer'], 'tile_bbox()');

-- tile maths -----------------------------------------------------------
SELECT is(tile_x(0, 1), 1, 'lon 0 -> x 1 at z1');
SELECT is(tile_y(0, 1), 1, 'lat 0 -> y 1 at z1');
SELECT is(tile_x(7.5, 14), 8533, 'lon 7.5 -> x 8533 at z14');
SELECT is(tile_y(46.5, 14), 5795, 'lat 46.5 -> y 5795 at z14');
SELECT ok(st_contains(tile_bbox(14, 8533, 5795),
                      st_setsrid(st_makepoint(7.5, 46.5), 4326)),
    'tile_bbox contains the point that maps to it');
SELECT is(
    (SELECT count(*)::int FROM tiles_for_geom(
        st_setsrid(st_makepoint(7.5, 46.5), 4326), 6, 14)),
    5, 'a point hits one tile per even zoom z6..z14');
SELECT is(
    (SELECT count(*)::int FROM tiles_for_geom(
        st_setsrid(st_makepoint(7.5, 46.5), 4326), 6, 18)),
    7, 'and 7 zooms up to z18');

-- fixtures -------------------------------------------------------------
CREATE TEMP TABLE ids AS
SELECT register('owner@example.com', 'password12') AS owner_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000a1'::uuid,
       st_envelope(st_buffer(tile_bbox(14, tile_x(7.5, 14), tile_y(46.5, 14)), -0.0005)),
       ids.owner_id, 14
FROM ids;

-- one edit -------------------------------------------------------------
INSERT INTO feature (id, area_id, kind, geom)
SELECT '00000000-0000-0000-0000-0000000000f1',
       '00000000-0000-0000-0000-0000000000a1', 'building',
       st_force3d(st_centroid(a.geom))
FROM area a WHERE a.id = '00000000-0000-0000-0000-0000000000a1';

SELECT is((SELECT count(*)::int FROM tile), 5,
    'one feature in a detail-14 area creates exactly 5 tiles');
SELECT results_eq(
    $$SELECT z::int FROM tile ORDER BY z$$,
    $$VALUES (6), (8), (10), (12), (14)$$,
    'the 5 tiles are z6, z8, z10, z12, z14');
SELECT is((SELECT count(*)::int FROM tile WHERE dirty), 5, 'all 5 are dirty');
SELECT is((SELECT max(expected_version) FROM tile), 2::bigint,
    'expected_version is 2: the land, then the feature on it');
SELECT ok(
    (SELECT bool_and(st_contains(tile_bbox(t.z, t.x, t.y), st_centroid(a.geom)))
     FROM tile t, area a WHERE a.id = '00000000-0000-0000-0000-0000000000a1'),
    'every dirtied tile contains the feature');

-- second edit ----------------------------------------------------------
UPDATE feature SET props = '{"height": 12}'::jsonb
WHERE id = '00000000-0000-0000-0000-0000000000f1';

SELECT is((SELECT count(*)::int FROM tile), 5, 'still 5 tiles after an update');
-- The z12, which has been there since the land was claimed. A tile that came
-- into being later has seen fewer edits, and since db/0089 the fine ones are
-- made when something earns them rather than all at once.
SELECT is((SELECT expected_version FROM tile WHERE z = 12), 3::bigint,
    'a third edit bumps it again');
SELECT is((SELECT rev FROM feature
           WHERE id = '00000000-0000-0000-0000-0000000000f1'), 2::bigint,
    'feature.rev follows the edit count');

-- deeper area: detail is read per area --------------------------------
-- Claimed here rather than with the first: since land is ground, claiming it is
-- what makes its tiles, and the counts above are about the first area's.
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000a2'::uuid,
       st_envelope(st_buffer(tile_bbox(18, tile_x(8.5, 18), tile_y(47.5, 18)), -0.00005)),
       ids.owner_id, 18
FROM ids;
INSERT INTO feature (area_id, kind, geom)
SELECT '00000000-0000-0000-0000-0000000000a2', 'natural', st_force3d(st_centroid(a.geom))
FROM area a WHERE a.id = '00000000-0000-0000-0000-0000000000a2';
-- db/0089: detail is a ceiling and the depth is earned. Water is a shape on
-- the ground, so it earns the first trained rung and not the last — the whole
-- point of the rule, since a lake at detail 18 used to ask for ninety trained
-- tiles a square kilometre of surface the elevation model already describes.
SELECT is((SELECT count(*)::int FROM tile WHERE z = 16), 1,
    'a detail-18 area with water on it earns its z16');
SELECT is((SELECT count(*)::int FROM tile WHERE z = 18), 0,
    'and no z18 at all: water has no walls to walk up to');
SELECT is((SELECT count(*)::int FROM tile), 10,
    '5 + 6 tiles, minus the z6 tile the two areas share');

-- A footprint does have walls, and earns the rung water does not.
INSERT INTO feature (area_id, kind, geom)
SELECT '00000000-0000-0000-0000-0000000000a2', 'building', st_force3d(st_centroid(a.geom))
FROM area a WHERE a.id = '00000000-0000-0000-0000-0000000000a2';
SELECT cmp_ok((SELECT count(*)::int FROM tile WHERE z = 18), '>', 0,
    'a building on the same ground earns z18');
-- And whole: a parent is replaced by its children when it refines, so a parent
-- with only some of them tears a hole in the ground (client/js/traverse.js).
SELECT is((SELECT count(*)::int FROM (
        SELECT DISTINCT x / 4 AS px, y / 4 AS py FROM tile WHERE z = 18) p), 1,
    'from one z16 parent');
-- Every child of that parent that lies on this land, which for a land the
-- size of one z18 tile is one of the sixteen. The set is ragged only at the
-- land's edge, where outside it there is no compiled ground to hole.
SELECT is((SELECT count(*)::int FROM tile WHERE z = 18),
    (SELECT count(*)::int FROM tiles_for_geom(
        (SELECT geom FROM area WHERE id = '00000000-0000-0000-0000-0000000000a2'),
        18, 18)),
    'and every one of them that is on this land, never a partial set');

-- outside any area -----------------------------------------------------
SELECT throws_ok($$INSERT INTO feature (area_id, kind, geom)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 'landuse',
            st_geomfromtext('POINTZ(0 0 0)', 4326))$$,
    null, 'an edit outside its area raises');

-- the trigger creates no jobs and no atoms (Invariant 4) ---------------
SELECT is((SELECT count(*)::int FROM job), 0, 'trigger created no job');
SELECT is((SELECT count(*)::int FROM atom), 0, 'trigger created no atom');

SELECT * FROM finish();
ROLLBACK;
