-- A job the pool will not hand out says why, and a tile asked for again
-- starts over what gave up (db/0201).
BEGIN;
SELECT plan(13);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('why201@example.com', 'password12') AS owner_id;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000201'::uuid,
       st_geomfromtext('POLYGON((7.88 46.29,7.89 46.29,7.89 46.30,7.88 46.30,7.88 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000201', 'building',
        st_geomfromtext('POINTZ(7.885 46.295 650)', 4326));
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT recompile_land('00000000-0000-0000-0000-000000000201');
CREATE TEMP TABLE tt AS SELECT tile_x(7.885, 14) AS x, tile_y(46.295, 14) AS y;
CREATE TEMP TABLE j AS SELECT ensure_job(14, (SELECT x FROM tt), (SELECT y FROM tt)) AS jid;

-- The caps a tab sends (client/js/workcaps.js).
CREATE TEMP TABLE c AS SELECT jsonb_build_object('webgpu', true, 'max_buffer_mb', 4096,
    'algo', jsonb_build_object('dataset', algo_current('dataset'), 'train', algo_current('train'),
                               'merge', algo_current('merge'), 'sog', algo_current('sog'))) AS caps;

SELECT is(job_refusal((SELECT jid FROM j), (SELECT caps FROM c)), NULL,
    'a job whose piece a tab can take has nothing to say');
SELECT alike(job_refusal((SELECT jid FROM j), '{"algo": {"dataset": "dataset-v7"}}'),
    '%reload the page%', 'a page that builds another version is told to reload');

CREATE TEMP TABLE ds AS SELECT * FROM claim_for((SELECT jid FROM j), (SELECT caps FROM c));
SELECT alike(job_refusal((SELECT jid FROM j), (SELECT caps FROM c)),
    '%in somebody''s hands%', 'a claimed piece is in somebody''s hands');
SELECT is(submit_atom((SELECT id FROM ds),
    register_artifact(repeat('a', 64), 'dataset', 4096, (SELECT algo_version FROM ds)),
    jsonb_build_object('splat_count', 1000, 'finite', true, 'gpu_seconds', 1,
        'frames', (SELECT (params ->> 'views')::int FROM ds),
        'bbox', '[-1, -1, -1, 1, 1, 1]'::jsonb)), 'verified', 'the dataset lands');

SELECT alike(job_refusal((SELECT jid FROM j), '{"webgpu": false}'),
    '%needs WebGPU%', 'the training says it needs WebGPU');
SELECT alike(job_refusal((SELECT jid FROM j), '{"webgpu": true, "max_buffer_mb": 1}'),
    '%buffer%', 'and how big a buffer it wants');

-- The training gives up: three attempts, three failures.
DO $$
DECLARE a atom%rowtype;
BEGIN
    FOR i IN 1..3 LOOP
        SELECT * INTO a FROM claim_for((SELECT jid FROM j), (SELECT caps FROM c));
        PERFORM fail_atom(a.id, 'the GPU fell over');
    END LOOP;
END
$$;
SELECT alike(job_refusal((SELECT jid FROM j), (SELECT caps FROM c)),
    '%gave up%', 'a job that gave up says so');
SELECT ok(job_gave_up((SELECT jid FROM j)), 'and the world knows it gave up');

-- Asked for again — an approval, a child landing, Compile it all again —
-- the job starts over rather than holding its failure.
SELECT is(ensure_job(14, (SELECT x FROM tt), (SELECT y FROM tt)), (SELECT jid FROM j),
    'asking for the tile again is the same job');
SELECT is((SELECT state FROM atom WHERE job_id = (SELECT jid FROM j) AND op = 'train'),
    'ready', 'with the piece that gave up back in the pool');
SELECT is(job_refusal((SELECT jid FROM j), (SELECT caps FROM c)), NULL,
    'and nothing refuses it');

-- The land moves on under the job.
UPDATE feature SET geom = st_geomfromtext('POINTZ(7.8851 46.2951 650)', 4326)
WHERE area_id = '00000000-0000-0000-0000-000000000201';
SELECT alike(job_refusal((SELECT jid FROM j), (SELECT caps FROM c)),
    '%the land changed%', 'a job the land moved past says so');
CREATE TEMP TABLE j2 AS SELECT ensure_job(14, (SELECT x FROM tt), (SELECT y FROM tt)) AS jid;
SELECT alike(job_refusal((SELECT jid FROM j), (SELECT caps FROM c)),
    '%job ' || (SELECT jid FROM j2) || ' replaced this one%',
    'and names the job that replaced it once there is one');

SELECT * FROM finish();
ROLLBACK;
