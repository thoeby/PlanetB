-- The tile is framed from z16-v3, and a job framed the old way is reopened
-- when a tab asks for it (db/0182).
BEGIN;
SELECT plan(5);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('afar182@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;
SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.86, 46.28, 7.92, 46.33);
CREATE TEMP TABLE a AS SELECT create_area(
    '{"type":"Polygon","coordinates":[[[7.880,46.295],[7.890,46.295],
                                       [7.890,46.305],[7.880,46.305],[7.880,46.295]]]}'::jsonb,
    14, 'afar182') AS id;
SELECT recompile_land((SELECT id FROM a));
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;
INSERT INTO worker (user_id, trust) SELECT owner_id, 1 FROM ids;

SELECT is((SELECT count(*) FROM atom WHERE job_id = (SELECT jid FROM j) AND op = 'frame'),
    5::bigint, 'a z14 tile is framed in five atoms of twenty');
SELECT is((SELECT params ->> 'camera_set' FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'train'), 'z16-v3',
    'and trained from z16-v3');
SELECT is((SELECT (params ->> 'to')::int FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'frame' ORDER BY id DESC LIMIT 1),
    81, 'the last chunk ends at view 81');

-- A job whose frames came from the old set is stale, and reopened on demand.
UPDATE atom SET params = params || '{"camera_set": "z16-v2"}', state = 'ready'
WHERE job_id = (SELECT jid FROM j) AND op = 'frame';
SELECT ok(stale_work_waiting(), 'frames from the old set are stale work');
SELECT isnt((SELECT job_id FROM claim_for((SELECT jid FROM j),
    '{"algo": {"assemble": "assemble-v11"}}')), (SELECT jid FROM j),
    'and asking for the job hands out work from the one that replaced it');

SELECT * FROM finish();
ROLLBACK;
