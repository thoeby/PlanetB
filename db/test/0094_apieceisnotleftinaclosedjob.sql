-- "Compile it all again" on unchanged ground: the new job's dataset is the
-- cancelled job's, and it must come along rather than wait there for ever.
BEGIN;
SELECT plan(8);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land94@example.com', 'password12') AS owner_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000094'::uuid,
       st_geomfromtext('POLYGON((7.8 46.29,7.81 46.29,7.81 46.30,7.8 46.30,7.8 46.29))',
                       4326),
       ids.owner_id, 18
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000094', 'building',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE tt AS SELECT 18 AS z, tile_x(7.805, 18) AS x, tile_y(46.295, 18) AS y;
CREATE TEMP TABLE first AS
SELECT ensure_job((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt)) AS jid;
CREATE TEMP TABLE asm AS
SELECT id FROM atom WHERE job_id = (SELECT jid FROM first) AND op = 'dataset';

-- The world does not move; the person asks for it again.
SELECT ok(recompile_land('00000000-0000-0000-0000-000000000094') > 0, 'the ground is marked');
SELECT is((SELECT state FROM job WHERE id = (SELECT jid FROM first)), 'cancelled',
    'and the job that was building it is cancelled');

CREATE TEMP TABLE second AS
SELECT ensure_job((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt)) AS jid;
SELECT isnt((SELECT jid FROM second), (SELECT jid FROM first), 'a new job is opened');
SELECT is((SELECT job_id FROM atom WHERE id = (SELECT id FROM asm)), (SELECT jid FROM second),
    'the dataset atom, unchanged, moves to the new job');
SELECT is((SELECT state FROM atom WHERE id = (SELECT id FROM asm)), 'ready',
    'and is somebody''s to take');
SELECT is((SELECT count(*) FROM atom
           WHERE job_id = (SELECT jid FROM second) AND state = 'waiting'),
    (SELECT count(*) FROM atom WHERE job_id = (SELECT jid FROM second)) - 1,
    'everything else in the job waits on it');

-- A verified dependency counts from the start: mark it done, ask again, and
-- the training is ready without anybody touching the dataset. The state
-- machine (db/0005) has no ready -> verified, so a worker claims it on the way.
INSERT INTO worker (id, user_id, caps, trust)
SELECT '00000000-0000-0000-0000-000000000941'::uuid, owner_id, '{}', 0.8 FROM ids;
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'dataset', 4096, 'dataset-v8');
UPDATE atom SET state = 'claimed', worker_id = '00000000-0000-0000-0000-000000000941',
    claimed_at = now(), heartbeat_at = now() WHERE id = (SELECT id FROM asm);
UPDATE atom SET state = 'verified', output_sha256 = repeat('a', 64),
    worker_id = NULL WHERE id = (SELECT id FROM asm);
SELECT ok(recompile_land('00000000-0000-0000-0000-000000000094') > 0, 'asked again');
CREATE TEMP TABLE third AS
SELECT ensure_job((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt)) AS jid;
SELECT is((SELECT count(*) FROM atom
           WHERE job_id = (SELECT jid FROM third) AND op = 'train' AND state = 'ready'),
    1::bigint,
    'the train atom of the new job is ready over the verified dataset');

SELECT * FROM finish();
ROLLBACK;
