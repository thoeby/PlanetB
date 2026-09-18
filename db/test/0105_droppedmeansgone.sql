-- A dropped job is gone from every count (db/0105_droppedmeansgone.sql).
BEGIN;
SELECT plan(7);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('gone@example.com', 'password12') AS owner_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-00000000ab05'::uuid,
       st_envelope(st_buffer(tile_bbox(14, tile_x(7.7, 14), tile_y(46.7, 14)), -0.0005)),
       ids.owner_id, 14
FROM ids;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job(14, tile_x(7.7, 14), tile_y(46.7, 14)) AS jid;
GRANT SELECT ON jobs TO player;

SELECT is((SELECT (params ->> 'iters')::int FROM atom
           WHERE job_id = (SELECT jid FROM jobs) AND op = 'train'), 2400,
    'a tile trains for 1200 steps (db/0122)');
SELECT ok(drop_job((SELECT jid FROM jobs)), 'an open job of yours can be dropped');
SELECT is((SELECT state FROM job WHERE id = (SELECT jid FROM jobs)), 'cancelled',
    'the job is cancelled');
SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = (SELECT jid FROM jobs) AND state IN ('ready', 'waiting')), 0,
    'none of its pieces is left for a tab');
SELECT is((SELECT expected_version FROM tile
           WHERE z = 14 AND x = tile_x(7.7, 14) AND y = tile_y(46.7, 14)),
    (SELECT published_version FROM tile
           WHERE z = 14 AND x = tile_x(7.7, 14) AND y = tile_y(46.7, 14)),
    'and the tile no longer asks for anything');
SELECT is((SELECT count(*)::int FROM jsonb_array_elements(render_pool()) j
           WHERE (j ->> 'job')::bigint = (SELECT jid FROM jobs)), 0,
    'so it is out of the pool');
SELECT ok(NOT drop_job((SELECT jid FROM jobs)), 'and dropping it again does nothing');

SELECT * FROM finish();
ROLLBACK;
