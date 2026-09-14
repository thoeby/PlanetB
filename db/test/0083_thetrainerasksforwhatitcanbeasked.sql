-- The z18 job that stopped with two pieces left: assembled, framed, and then a
-- train atom no tab could claim because it asked for 4 GB of VRAM and no
-- browser reports VRAM at all.
BEGIN;
SELECT plan(8);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land83@example.com', 'password12') AS owner_id,
       register('rend83@example.com', 'password12') AS worker_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000083'::uuid,
       st_geomfromtext('POLYGON((7.8 46.29,7.81 46.29,7.81 46.30,7.8 46.30,7.8 46.29))',
                       4326),
       ids.owner_id, 18
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000083', 'footprint',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));

CREATE TEMP TABLE tt AS SELECT 18 AS z, tile_x(7.805, 18) AS x, tile_y(46.295, 18) AS y;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt)) AS jid;

-- What the DAG asks for now: a buffer, in MB, and no VRAM.
SELECT is((SELECT (params ->> 'min_vram_gb') FROM atom
           WHERE job_id = (SELECT jid FROM jobs) AND op = 'train'), null,
    'the trainer no longer asks for a card''s memory');
SELECT is((SELECT (params ->> 'min_buffer_mb')::numeric FROM atom
           WHERE job_id = (SELECT jid FROM jobs) AND op = 'train'),
    ceil(96::numeric * tile_budget(18) / 1048576),
    'it asks for the widest per-splat buffer it will allocate');
SELECT is((SELECT atom_buffer_mb(a) FROM atom a
           WHERE a.job_id = (SELECT jid FROM jobs) AND a.op = 'assemble'), 0::numeric,
    'and nothing that is not training asks for one');

-- Assemble and every frame, so the job is left exactly where the player's was.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', worker_id, 'role', 'player')::text, true) FROM ids;
DO $$
DECLARE a atom%rowtype; sha text; n int := 0;
BEGIN
    LOOP
        a := claim_for((SELECT jid FROM jobs),
                       '{"webgpu": true, "max_buffer_mb": 1024, "ops": []}'::jsonb);
        EXIT WHEN a.id IS NULL OR a.op = 'train' OR n > 30;
        n := n + 1;
        sha := lpad(to_hex(a.id), 64, '0');
        PERFORM register_artifact(sha,
            CASE a.op WHEN 'assemble' THEN 'init_ply' ELSE 'frames' END, 4096, 'x');
        PERFORM submit_atom(a.id, sha, jsonb_build_object(
            'splat_count', 1000, 'finite', true, 'gpu_seconds', 1,
            'bbox', jsonb_build_array(-50, -5, -50, 50, 20, 50),
            'frames', 20, 'views', 20, 'width', 256, 'height', 256,
            'camera_set', 'z18-v1'));
    END LOOP;
    -- The train atom the loop stopped on goes back, so the claims below start
    -- from the state the player's tab was left in.
    IF a.id IS NOT NULL THEN
        UPDATE atom SET state = 'ready', worker_id = null, claimed_at = null,
                        heartbeat_at = null WHERE id = a.id;
    END IF;
END $$;

SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = (SELECT jid FROM jobs) AND state IN ('ready', 'waiting')), 2,
    'two pieces left: the training and the encoding of it');
CREATE TEMP TABLE row83 AS
SELECT j FROM jsonb_array_elements(render_pool(7.805, 46.295, 5)) j;
SELECT is((SELECT (j ->> 'ready')::int FROM row83), 2,
    'which is what the pool says');
SELECT is((SELECT (j ->> 'needs_mb')::numeric FROM row83),
    ceil(96::numeric * tile_budget(18) / 1048576),
    'and it says how big a buffer the tab has to be able to hold');

-- The whole point: a tab with WebGPU and a gigabyte of buffer takes it.
SELECT isnt((claim_for((SELECT jid FROM jobs),
             '{"webgpu": true, "max_buffer_mb": 1024}'::jsonb)).id, null,
    'a tab whose adapter hands out a gigabyte can train a z18 tile');

-- And one that has answered that it cannot does not.
UPDATE atom SET state = 'ready', worker_id = null, claimed_at = null,
                heartbeat_at = null
WHERE job_id = (SELECT jid FROM jobs) AND op = 'train';
SELECT is((claim_for((SELECT jid FROM jobs),
           '{"webgpu": true, "max_buffer_mb": 16}'::jsonb)).id, null,
    'and one that says it cannot hold the buffer is not given the work');

ROLLBACK;
