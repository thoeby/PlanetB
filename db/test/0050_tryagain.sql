-- A tile that failed three times can be tried again by the person whose ground
-- it is (db/0050_tryagain.sql).
BEGIN;
SELECT plan(8);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('stuck@example.com', 'password12') AS owner_id,
       register('passer2@example.com', 'password12') AS stranger_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-00000000ab02'::uuid,
       st_envelope(st_buffer(tile_bbox(14, tile_x(7.5, 14), tile_y(46.5, 14)), -0.0005)),
       ids.owner_id, 14
FROM ids;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job(14, tile_x(7.5, 14), tile_y(46.5, 14)) AS jid;
GRANT SELECT ON jobs TO player;

-- Three bad attempts at the first atom, the way a GeoServer that is not ready
-- produces them.
UPDATE atom SET state = 'failed', attempts = 3
WHERE job_id = (SELECT jid FROM jobs) AND op = 'assemble';

SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = (SELECT jid FROM jobs) AND state = 'failed'), 1,
    'the tile is stuck');
SELECT ok((SELECT (j ->> 'failed')::int > 0 FROM
    jsonb_array_elements(render_pool()) j
    WHERE (j ->> 'job')::bigint = (SELECT jid FROM jobs)),
    'the pool says so rather than hiding it');

-- Not everybody's to unstick -------------------------------------------
SELECT set_config('request.jwt.claims',
    json_build_object('sub', stranger_id, 'role', 'player')::text, true) FROM ids;
SELECT ok(NOT may_retry_job((SELECT jid FROM jobs)),
    'a passer-by is not offered it');
SELECT throws_ok(format($$SELECT retry_job(%s)$$, (SELECT jid FROM jobs)),
    '42501', null, 'and cannot');

-- The owner's -----------------------------------------------------------
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT ok(may_retry_job((SELECT jid FROM jobs)), 'the owner of the ground is');
SELECT is(retry_job((SELECT jid FROM jobs)), 1, 'and tries it again');
SELECT is((SELECT state FROM atom
           WHERE job_id = (SELECT jid FROM jobs) AND op = 'assemble'), 'ready',
    'the atom is handed out again, from the beginning');
SELECT is((SELECT attempts::int FROM atom
           WHERE job_id = (SELECT jid FROM jobs) AND op = 'assemble'), 0,
    'with its three strikes forgotten');

SELECT * FROM finish();
ROLLBACK;
