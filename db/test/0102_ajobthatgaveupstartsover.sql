-- A stuck job starts over from its first atom, or is dropped from the pool
-- (db/0102_ajobthatgaveupstartsover.sql).
BEGIN;
SELECT plan(7);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('over@example.com', 'password12') AS owner_id,
       register('passer3@example.com', 'password12') AS stranger_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-00000000ab03'::uuid,
       st_envelope(st_buffer(tile_bbox(14, tile_x(7.6, 14), tile_y(46.6, 14)), -0.0005)),
       ids.owner_id, 14
FROM ids;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job(14, tile_x(7.6, 14), tile_y(46.6, 14)) AS jid;
GRANT SELECT ON jobs TO player;

-- The first atom finished, with an artifact the last one cannot use.
UPDATE atom SET state = 'verified', output_sha256 = repeat('a', 64), attempts = 1
WHERE job_id = (SELECT jid FROM jobs) AND op = 'assemble';
UPDATE atom SET state = 'failed', attempts = 3
WHERE job_id = (SELECT jid FROM jobs) AND op <> 'assemble';

SELECT ok(retry_job((SELECT jid FROM jobs)) >= 2, 'every atom of the job is put back');
SELECT is((SELECT state FROM atom WHERE job_id = (SELECT jid FROM jobs) AND op = 'assemble'),
    'ready', 'the finished first atom is done again, not reused');
SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = (SELECT jid FROM jobs) AND output_sha256 IS NOT NULL), 0,
    'nothing the job made before is kept');
SELECT is(retry_job((SELECT jid FROM jobs)), 0, 'a job with nothing failed is left alone');

-- Dropping ---------------------------------------------------------------
SELECT set_config('request.jwt.claims',
    json_build_object('sub', stranger_id, 'role', 'player')::text, true) FROM ids;
SELECT throws_ok(format('SELECT drop_job(%s)', (SELECT jid FROM jobs)), '42501',
    NULL, 'not everybody may drop it');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT ok(drop_job((SELECT jid FROM jobs)), 'its owner may');
SELECT is((SELECT state FROM job WHERE id = (SELECT jid FROM jobs)), 'cancelled',
    'and the job is gone from the pool');

SELECT * FROM finish();
ROLLBACK;
