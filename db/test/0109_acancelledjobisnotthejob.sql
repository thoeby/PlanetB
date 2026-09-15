-- A cancelled job never stands in for the next one, and what approve says
-- it opened is open (db/0109_acancelledjobisnotthejob.sql).
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('again@example.com', 'password12') AS owner_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-00000000ab09'::uuid,
       st_envelope(st_buffer(tile_bbox(14, tile_x(7.6, 14), tile_y(46.6, 14)), -0.0005)),
       ids.owner_id, 14
FROM ids;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job(14, tile_x(7.6, 14), tile_y(46.6, 14)) AS first;
GRANT SELECT ON jobs TO player;

SELECT is(job_outcome((SELECT first FROM jobs)), 'open', 'a fresh job is open');

-- Dropped, then wanted again at the same version.
SELECT ok(drop_job((SELECT first FROM jobs)), 'dropped');
UPDATE tile SET dirty = true, expected_version = expected_version + 1
WHERE z = 14 AND x = tile_x(7.6, 14) AND y = tile_y(46.6, 14);
UPDATE job SET state = 'cancelled'
WHERE z = 14 AND x = tile_x(7.6, 14) AND y = tile_y(46.6, 14);
-- (a cancelled job at the tile's current version, the trap db/0105 set)
UPDATE job SET target_version = (SELECT expected_version FROM tile
                                 WHERE z = 14 AND x = tile_x(7.6, 14) AND y = tile_y(46.6, 14))
WHERE id = (SELECT first FROM jobs);

CREATE TEMP TABLE again AS
SELECT ensure_job(14, tile_x(7.6, 14), tile_y(46.6, 14)) AS second;
SELECT isnt((SELECT second FROM again), (SELECT first FROM jobs),
    'the cancelled job is not handed back');
SELECT is((SELECT state FROM job WHERE id = (SELECT second FROM again)), 'open',
    'a new one is open');
SELECT is(job_outcome((SELECT second FROM again)), 'open', 'and says so');
SELECT ok((SELECT count(*) FROM jsonb_array_elements(render_pool()) j
           WHERE (j ->> 'job')::bigint = (SELECT second FROM again)) = 1,
    'and it is in the pool');

SELECT * FROM finish();
ROLLBACK;
