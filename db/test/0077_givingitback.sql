-- Giving land back (db/0077_givingitback.sql): what the confirmation says,
-- who may do it, and what the tiles under it become.
BEGIN;
SELECT plan(10);

CREATE TEMP TABLE who AS
SELECT register('ben77@example.com', 'password12') AS ben,
       register('cara77@example.com', 'password12') AS cara;
GRANT SELECT ON who TO player;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
SELECT set_my_name('Ben');
INSERT INTO area (id, geom, owner_id, detail, rules)
SELECT '00000000-0000-0000-0000-0000000000e1'::uuid,
       st_makeenvelope(7.60, 46.60, 7.61, 46.61, 4326), ben, 14,
       '{"name": "Ben''s meadow"}'::jsonb
FROM who;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000e1',
        'forest',
        st_force3d(st_makeenvelope(7.602, 46.602, 7.606, 46.606, 4326)));

-- One of its tiles is published, so "returns to ground" has something to undo.
SET LOCAL role = 'postgres';
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'sog', 1, 'sog-v1');
UPDATE tile SET published_version = expected_version, dirty = false,
                sog_sha256 = repeat('a', 64),
                manifest = '{"splats": 1}'::jsonb, published_at = now()
WHERE z = 14 AND st_intersects(
    (SELECT geom FROM area WHERE id = '00000000-0000-0000-0000-0000000000e1'),
    tile_bbox(z, x, y));
SET LOCAL role = 'player';

SELECT is((SELECT land_removal('00000000-0000-0000-0000-0000000000e1') ->> 'land'),
          'Ben''s meadow', 'the confirmation names the land');
SELECT is((SELECT (land_removal('00000000-0000-0000-0000-0000000000e1')
                   ->> 'features')::int),
          1, 'and says how many features go with it');
SELECT cmp_ok((SELECT (land_removal('00000000-0000-0000-0000-0000000000e1')
                       ->> 'tiles')::int), '>', 0,
              'and how many tiles are published on it');

-- A stranger may not give away somebody's land.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', cara, 'role', 'player')::text, true) FROM who;
SELECT throws_ok($$SELECT remove_area('00000000-0000-0000-0000-0000000000e1')$$,
    '42501', null, 'only the owner gives the land back');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
CREATE TEMP TABLE went AS
SELECT remove_area('00000000-0000-0000-0000-0000000000e1') AS r;
GRANT SELECT ON went TO player;

SELECT is((SELECT (r ->> 'features')::int FROM went), 1,
          'the deed returns what went with it');
SELECT is((SELECT count(*) FROM area
           WHERE id = '00000000-0000-0000-0000-0000000000e1'), 0::bigint,
          'the land is gone');
SELECT is((SELECT count(*) FROM feature
           WHERE area_id = '00000000-0000-0000-0000-0000000000e1'), 0::bigint,
          'and what was drawn on it went too');
SELECT is((SELECT count(*) FROM tile
           WHERE published_version > 0
             AND st_intersects(st_makeenvelope(7.60, 46.60, 7.61, 46.61, 4326),
                               tile_bbox(z, x, y))), 0::bigint,
          'the tiles under it publish nothing any more');
SELECT is((SELECT count(*) FROM tile
           WHERE dirty
             AND st_intersects(st_makeenvelope(7.60, 46.60, 7.61, 46.61, 4326),
                               tile_bbox(z, x, y))), 0::bigint,
          'and none of them is waiting to be compiled');
SELECT throws_ok($$SELECT remove_area('00000000-0000-0000-0000-0000000000e1')$$,
    '23503', null, 'giving it back twice says there is no such land');

SELECT * FROM finish();
ROLLBACK;
