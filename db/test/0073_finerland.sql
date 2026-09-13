-- How fine a piece of land says it is compiled (db/0073_finerland.sql):
-- `area.detail` decides the smallest tile the ground is ever cut into, and the
-- Land panel is what asks for it. What a tile may hold is db/test/0074.
BEGIN;
SELECT plan(2);

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
