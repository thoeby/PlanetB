-- What a tile is allowed to hold (db/0073_finerland.sql), and what the land
-- says it is compiled at. The numbers matter to the eye: a z14 tile is nearly
-- two kilometres across, and what it may hold decides whether the ground under
-- somebody standing on it is a surface or a smear.
BEGIN;
SELECT plan(6);

SELECT is(tile_budget(14), 2000000::bigint, 'a z14 tile may hold two million');
SELECT is(tile_budget(16), 600000::bigint, 'a trained z16 tile is what it was');
SELECT cmp_ok(tile_budget(14), '>', tile_budget(12),
              'and the tiles above it are no denser than the one below');

CREATE TEMP TABLE who AS SELECT register('fine73@example.com', 'password12') AS uid;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'player')::text, true) FROM who;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000c1'::uuid,
       st_makeenvelope(7.50, 46.50, 7.51, 46.51, 4326), uid, 14
FROM who;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000c1', 'footprint',
        st_geomfromtext('POINTZ(7.505 46.505 500)', 4326));

-- The budget reaches the atom that makes the splats, which is what the eye
-- sees. Invariant 2: it is pinned there, so this tile keeps it however the
-- number changes afterwards.
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.505, 14), tile_y(46.505, 14), 0) AS id;
SELECT is((SELECT (params ->> 'budget')::bigint FROM atom
           WHERE job_id = (SELECT id FROM j) AND op = 'sample'),
          2000000::bigint, 'and the sample atom is told to make that many');

-- Finer land is more tiles, and they are changed rather than published
-- (db/0038_authoring.sql).
SELECT cmp_ok(set_area_detail('00000000-0000-0000-0000-0000000000c1', 16),
              '>', 0, 'asking for finer land gives the world more to compile');
SELECT ok(EXISTS (SELECT 1 FROM tile t
                  WHERE t.z = 16 AND t.dirty
                    AND st_intersects(tile_bbox(t.z, t.x, t.y),
                        (SELECT geom FROM area
                         WHERE id = '00000000-0000-0000-0000-0000000000c1'))),
          'and z16 tiles are what it added');

SELECT * FROM finish();
ROLLBACK;
