-- WP0.5 acceptance: a feature in a detail-14 area bumps exactly the 5 tiles
-- (z6…z14) that contain it; two edits bump by 2; an edit outside any area raises.
BEGIN;
SELECT plan(22);

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
       st_geomfromtext('POLYGON((7.4 46.4,7.6 46.4,7.6 46.6,7.4 46.6,7.4 46.4))', 4326),
       ids.owner_id, 14
FROM ids;
-- a second, deeper area far away, to prove detail is read per area
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000a2'::uuid,
       st_geomfromtext('POLYGON((8.4 47.4,8.6 47.4,8.6 47.6,8.4 47.6,8.4 47.4))', 4326),
       ids.owner_id, 18
FROM ids;

-- one edit -------------------------------------------------------------
INSERT INTO feature (id, area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000f1',
        '00000000-0000-0000-0000-0000000000a1', 'footprint',
        st_geomfromtext('POINTZ(7.5 46.5 500)', 4326));

SELECT is((SELECT count(*)::int FROM tile), 5,
    'one feature in a detail-14 area creates exactly 5 tiles');
SELECT results_eq(
    $$SELECT z::int FROM tile ORDER BY z$$,
    $$VALUES (6), (8), (10), (12), (14)$$,
    'the 5 tiles are z6, z8, z10, z12, z14');
SELECT is((SELECT count(*)::int FROM tile WHERE dirty), 5, 'all 5 are dirty');
SELECT is((SELECT max(expected_version) FROM tile), 1::bigint,
    'expected_version is 1 after one edit');
SELECT ok(
    (SELECT bool_and(st_contains(tile_bbox(z, x, y),
                                 st_setsrid(st_makepoint(7.5, 46.5), 4326)))
     FROM tile),
    'every dirtied tile contains the feature');

-- second edit ----------------------------------------------------------
UPDATE feature SET props = '{"height": 12}'::jsonb
WHERE id = '00000000-0000-0000-0000-0000000000f1';

SELECT is((SELECT count(*)::int FROM tile), 5, 'still 5 tiles after an update');
SELECT is((SELECT min(expected_version) FROM tile), 2::bigint,
    'two edits bump expected_version to 2');
SELECT is((SELECT rev FROM feature
           WHERE id = '00000000-0000-0000-0000-0000000000f1'), 2::bigint,
    'feature.rev follows the edit count');

-- deeper area: detail is read per area --------------------------------
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000a2', 'water',
        st_geomfromtext('POINTZ(8.5 47.5 400)', 4326));
SELECT is((SELECT count(*)::int FROM tile WHERE z > 14), 2,
    'a detail-18 area also dirties z16 and z18');
SELECT is((SELECT count(*)::int FROM tile), 11,
    '5 + 7 tiles, minus the z6 tile the two areas share');

-- outside any area -----------------------------------------------------
SELECT throws_ok($$INSERT INTO feature (area_id, kind, geom)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 'forest',
            st_geomfromtext('POINTZ(0 0 0)', 4326))$$,
    null, 'an edit outside its area raises');

-- the trigger creates no jobs and no atoms (Invariant 4) ---------------
SELECT is((SELECT count(*)::int FROM job), 0, 'trigger created no job');
SELECT is((SELECT count(*)::int FROM atom), 0, 'trigger created no atom');

SELECT * FROM finish();
ROLLBACK;
