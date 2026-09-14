-- A change reads the ground it is on, not the whole land: the same tiles
-- db/0089 earns, pruned to what moved, and still in whole blocks.
BEGIN;
SELECT plan(7);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('near91@example.com', 'password12') AS owner_id;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000091'::uuid,
       st_geomfromtext('POLYGON((7.800 46.250,7.950 46.250,7.950 46.350,'
                       '7.800 46.350,7.800 46.250))', 4326),
       ids.owner_id, 18
FROM ids;

-- A building in one corner of it.
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000091', 'footprint',
        st_force3d(st_geomfromtext('POLYGON((7.8700 46.2900,7.8704 46.2900,'
                                   '7.8704 46.2904,7.8700 46.2904,'
                                   '7.8700 46.2900))', 4326)));

CREATE TEMP TABLE near AS
SELECT * FROM area_tiles_over('00000000-0000-0000-0000-000000000091',
    (SELECT geom FROM feature
     WHERE area_id = '00000000-0000-0000-0000-000000000091'));

CREATE TEMP TABLE whole AS
SELECT * FROM area_tiles('00000000-0000-0000-0000-000000000091');

-- The rule: never a tile the land itself would not be made of.
SELECT is((SELECT count(*)::int FROM near n
           WHERE NOT EXISTS (SELECT 1 FROM whole w
                             WHERE w.z = n.z AND w.x = n.x AND w.y = n.y)), 0,
    'every tile a change earns is one the land is made of');

-- And it is the near ground, not all of it.
SELECT cmp_ok((SELECT count(*)::int FROM near), '<',
    (SELECT count(*)::int FROM whole),
    'and fewer of them than the whole land');

-- The ladder is walked all the way down to where the building stands.
SELECT is((SELECT max(z)::int FROM near), 18,
    'a building still earns the last rung under it');
SELECT is((SELECT count(*)::int FROM near WHERE z = 6), 1,
    'and the coarse tile over it is there too');

-- THE RULE db/0089 MUST NOT BREAK: a parent that refines is replaced by its
-- children, so a block of sixteen is whole or it is a hole in the ground
-- (client/js/traverse.js). Pruning takes whole subtrees, never part of a block.
-- Ragged at the land's edge, as db/0089 says it always was, so the block is
-- measured against the one the whole land would have made, not against
-- sixteen.
SELECT is(
    (SELECT count(*)::int FROM whole w
     WHERE EXISTS (SELECT 1 FROM near n
                   WHERE n.z = w.z AND n.x / 4 = w.x / 4 AND n.y / 4 = w.y / 4)
       AND NOT EXISTS (SELECT 1 FROM near n
                       WHERE n.z = w.z AND n.x = w.x AND n.y = w.y)), 0,
    'every block it reaches is whole — it never takes half of one');

-- Empty ground far from the building earns nothing finer than the baseline,
-- even though the land's ceiling is 18.
SELECT is(
    (SELECT max(z)::int FROM area_tiles_over(
        '00000000-0000-0000-0000-000000000091',
        st_setsrid(st_point(7.9400, 46.3400), 4326))), 14,
    'and a change on empty ground stops at the baseline');

-- db/0056's rule, said once and now read once: the CRS tile_bbox() stamps is
-- still the one the world's geometry is in.
SELECT is(st_srid(tile_bbox(14, 100, 100)),
    (SELECT st_srid(geom) FROM area WHERE id = '00000000-0000-0000-0000-000000000091'),
    'a tile is in the same projection as the ground it covers');

SELECT * FROM finish();
ROLLBACK;
