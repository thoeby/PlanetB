-- Detail is a ceiling and the depth is earned: a lake does not ask for ninety
-- trained tiles a square kilometre of a surface the elevation model already
-- describes, and a building still gets the tiles it needs.
BEGIN;
SELECT plan(9);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('fine89@example.com', 'password12') AS owner_id;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000089'::uuid,
       st_geomfromtext('POLYGON((7.875 46.290,7.885 46.290,7.885 46.297,'
                       '7.875 46.297,7.875 46.290))', 4326),
       ids.owner_id, 18
FROM ids;

-- Empty ground, at the deepest ceiling there is.
SELECT is((SELECT max(z)::int FROM area_tiles('00000000-0000-0000-0000-000000000089')), 14,
    'empty land at detail 18 stops at the baseline, whatever its ceiling');

-- A lake. Water is a shape on the ground: it earns the first trained rung and
-- not the last.
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000089', 'natural',
        st_force3d(st_geomfromtext('POLYGON((7.876 46.291,7.884 46.291,'
                                   '7.884 46.296,7.876 46.296,7.876 46.291))', 4326)));
SELECT is((SELECT max(z)::int FROM area_tiles('00000000-0000-0000-0000-000000000089')), 16,
    'a lake earns z16 and stops there');
SELECT cmp_ok((SELECT count(*)::int FROM area_tiles('00000000-0000-0000-0000-000000000089')
               WHERE z = 16), '>', 0, 'and it does earn them');

-- A building has walls you walk up to.
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000089', 'building',
        st_force3d(st_geomfromtext('POLYGON((7.8770 46.2915,7.8772 46.2915,'
                                   '7.8772 46.2917,7.8770 46.2917,'
                                   '7.8770 46.2915))', 4326)));
SELECT is((SELECT max(z)::int FROM area_tiles('00000000-0000-0000-0000-000000000089')), 18,
    'a building earns the last rung');

-- Whole blocks, never a partial set: a parent is replaced by its children when
-- it refines, so a parent holding only some of them tears a hole in the ground
-- (client/js/traverse.js). Every z18 of a descending z16 parent that lies on
-- this land is there.
SELECT is(
    (SELECT count(*)::int FROM area_tiles('00000000-0000-0000-0000-000000000089')
     WHERE z = 18),
    (SELECT count(*)::int FROM tiles_for_geom(
        (SELECT geom FROM area WHERE id = '00000000-0000-0000-0000-000000000089'),
        18, 18) c
     WHERE EXISTS (SELECT 1 FROM area_tiles('00000000-0000-0000-0000-000000000089') p
                   WHERE p.z = 16 AND p.x = c.x / 4 AND p.y = c.y / 4
                     AND tile_earns_finer(16, p.x, p.y,
                                          '00000000-0000-0000-0000-000000000089'))),
    'and every child of a parent that splits, never a partial set');

-- What the kind says is what decides it, because what the world may hold is a
-- table and not a list in code (db/0040_properties.sql).
SELECT is((SELECT fine FROM kind WHERE name = 'natural'), false,
    'water is a shape on the ground');
SELECT is((SELECT fine FROM kind WHERE name = 'building'), true,
    'a footprint is not');

-- The tiles are made and marked: a block nobody dirtied would never be sent.
SELECT is((SELECT count(*)::int FROM tile WHERE z = 18 AND NOT dirty), 0,
    'every tile a change earns is marked to be built');

-- And taking the building away marks the tiles it stood on once more, because
-- what is compiled into those still has it in. Not every tile of the block:
-- the other fifteen never had it, and are still waiting to be built at all.
UPDATE feature SET deleted_at = now()
WHERE area_id = '00000000-0000-0000-0000-000000000089' AND kind = 'building';
SELECT cmp_ok((SELECT count(*)::int FROM tile WHERE z = 18 AND expected_version > 1),
    '>', 0, 'and taking it away marks the tiles it stood on once more');

ROLLBACK;
