-- A tile that was rendered can be rendered again, and a job that cannot finish
-- stops pretending it will (db/0081_compileitagain.sql).
BEGIN;
SELECT plan(7);

CREATE TEMP TABLE who AS
SELECT register('ben81@example.com', 'password12') AS ben,
       register('cara81@example.com', 'password12') AS cara;
GRANT SELECT ON who TO player;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
INSERT INTO area (id, geom, owner_id, detail, rules)
SELECT '00000000-0000-0000-0000-0000000000b1'::uuid,
       st_makeenvelope(7.30, 46.30, 7.31, 46.31, 4326), ben, 14,
       '{"name": "the high field"}'::jsonb
FROM who;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000b1', 'landuse',
        st_force3d(st_makeenvelope(7.302, 46.302, 7.306, 46.306, 4326)));

CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.305, 14), tile_y(46.305, 14), 0) AS id;
GRANT SELECT ON j TO player;

SELECT ok(job_can_work((SELECT id FROM j)), 'a fresh job has work in it');

-- A tab takes every atom and goes away without finishing: the job is open,
-- nothing in it can be worked, and the pool cannot see it.
SET LOCAL role = 'postgres';
INSERT INTO worker (id, user_id, caps)
SELECT '00000000-0000-0000-0000-0000000000f9', ben, '{}'::jsonb FROM who;
UPDATE atom SET state = 'claimed',
                worker_id = '00000000-0000-0000-0000-0000000000f9',
                claimed_at = now(), heartbeat_at = now()
WHERE job_id = (SELECT id FROM j) AND state = 'ready';
UPDATE atom SET state = 'submitted' WHERE job_id = (SELECT id FROM j)
  AND state = 'claimed';
UPDATE atom SET state = 'verified' WHERE job_id = (SELECT id FROM j)
  AND state = 'submitted';
UPDATE atom SET state = 'ready' WHERE job_id = (SELECT id FROM j)
  AND state = 'waiting';
UPDATE atom SET state = 'claimed',
                worker_id = '00000000-0000-0000-0000-0000000000f9',
                claimed_at = now(), heartbeat_at = now()
WHERE job_id = (SELECT id FROM j) AND state = 'ready';
UPDATE atom SET state = 'submitted' WHERE job_id = (SELECT id FROM j)
  AND state = 'claimed';
UPDATE atom SET state = 'verified' WHERE job_id = (SELECT id FROM j)
  AND state = 'submitted';
-- What a verified sog atom always carries: the bytes it made, and the manifest
-- that says where the tile they are is.
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('b', 64), 'sog', 1, 'sog-v1');
UPDATE atom SET output_sha256 = repeat('b', 64),
                result = jsonb_build_object('manifest',
                    jsonb_build_object('splats', 1,
                        'origin', jsonb_build_object('lon', 7.305, 'lat', 46.305,
                                                     'h', 700)))
WHERE job_id = (SELECT id FROM j) AND op = 'sog';
SET LOCAL role = 'player';

SELECT ok(NOT job_can_work((SELECT id FROM j)),
          'a job whose atoms all finished has none');
SELECT is((SELECT count(*) FROM jsonb_array_elements(render_pool()) p
           WHERE (p ->> 'job')::bigint = (SELECT id FROM j)),
          0::bigint, 'and the pool does not list it, so nobody can take it');

-- Asking for it again used to hand back the same dead end. Now it is revived.
SELECT is(ensure_job(14, tile_x(7.305, 14), tile_y(46.305, 14), 0),
          (SELECT id FROM j), 'asking again is the same job (Invariant 4)');
-- What it was missing was not the work: it was the pointer update at the end
-- of it, and reviving the job made that happen.
SELECT cmp_ok((SELECT published_version FROM tile
               WHERE z = 14 AND x = tile_x(7.305, 14) AND y = tile_y(46.305, 14)),
              '>', 0::bigint, 'the tile it had already made is published');

-- "Build it again", when nothing about the land changed but the recipe did.
SET LOCAL role = 'postgres';
UPDATE tile SET dirty = false, published_version = expected_version
WHERE st_intersects(st_makeenvelope(7.30, 46.30, 7.31, 46.31, 4326),
                    tile_bbox(z, x, y));
SET LOCAL role = 'player';
SELECT cmp_ok(recompile_land('00000000-0000-0000-0000-0000000000b1'), '>', 0,
              'the owner can ask for the whole of it to be built again');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', cara, 'role', 'player')::text, true) FROM who;
SELECT throws_ok(
    $$SELECT recompile_land('00000000-0000-0000-0000-0000000000b1')$$,
    '42501', null, 'and nobody else can');

SELECT * FROM finish();
ROLLBACK;
