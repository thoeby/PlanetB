-- A pool that says why it has nothing in it (db/0082_whythepoolisempty.sql).
BEGIN;
SELECT plan(5);

CREATE TEMP TABLE who AS SELECT register('pool82@example.com', 'password12') AS uid;
GRANT SELECT ON who TO player;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'player')::text, true) FROM who;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000a7'::uuid,
       st_makeenvelope(7.20, 46.20, 7.21, 46.21, 4326), uid, 14
FROM who;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000a7', 'forest',
        st_force3d(st_makeenvelope(7.202, 46.202, 7.206, 46.206, 4326)));

CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.205, 14), tile_y(46.205, 14), 0) AS id;
GRANT SELECT ON j TO player;

SELECT cmp_ok((SELECT count(*) FROM jsonb_array_elements(render_pool())), '>', 0::bigint,
              'a job that can be taken is in the pool');
SELECT is((SELECT count(*) FROM jsonb_array_elements(pool_held_back(500)) h
           WHERE (h ->> 'job')::bigint = (SELECT id FROM j)),
          0::bigint, 'and is not held back');

-- The land moves on under it: the job can finish every atom and publish none.
SET LOCAL role = 'postgres';
UPDATE tile SET expected_version = expected_version + 1, dirty = true
WHERE z = 14 AND x = tile_x(7.205, 14) AND y = tile_y(46.205, 14);
SET LOCAL role = 'player';

SELECT is((SELECT count(*) FROM jsonb_array_elements(render_pool()) p
           WHERE (p ->> 'job')::bigint = (SELECT id FROM j)),
          0::bigint, 'the pool stops offering it');
SELECT is((SELECT h ->> 'why' FROM jsonb_array_elements(pool_held_back(500)) h
           WHERE (h ->> 'job')::bigint = (SELECT id FROM j)),
          'the land changed after this was opened — submit it again',
          'and says why it is not there');

-- The other reason somebody meets: every piece of it finished and the publish
-- is what is missing (db/0081_compileitagain.sql).
SET LOCAL role = 'postgres';
INSERT INTO worker (id, user_id, caps)
SELECT '00000000-0000-0000-0000-0000000000e8', uid, '{}'::jsonb FROM who;
UPDATE atom SET state = 'ready' WHERE job_id = (SELECT id FROM j) AND state = 'waiting';
UPDATE atom SET state = 'claimed',
                worker_id = '00000000-0000-0000-0000-0000000000e8',
                claimed_at = now(), heartbeat_at = now()
WHERE job_id = (SELECT id FROM j) AND state = 'ready';
UPDATE atom SET state = 'submitted' WHERE job_id = (SELECT id FROM j)
  AND state = 'claimed';
UPDATE atom SET state = 'verified' WHERE job_id = (SELECT id FROM j)
  AND state = 'submitted';
UPDATE tile SET expected_version = (SELECT target_version FROM job
                                    WHERE id = (SELECT id FROM j))
WHERE z = 14 AND x = tile_x(7.205, 14) AND y = tile_y(46.205, 14);
SET LOCAL role = 'player';
SELECT ok((SELECT h ->> 'why' FROM jsonb_array_elements(pool_held_back(500)) h
           WHERE (h ->> 'job')::bigint = (SELECT id FROM j))
          LIKE '%publish that is missing%',
          'a job with the work done and no publish says so rather than vanishing');

SELECT * FROM finish();
ROLLBACK;
