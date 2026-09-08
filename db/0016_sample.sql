-- 0016_sample.sql — the baseline tile, and the DAG that builds it.
--
-- TASKS.md's decision for WP2.8: a z14 tile is not trained. It is assembled and
-- then sampled at the tile's whole budget, which is what `sample-v1` is, and
-- the .sog of that is what the world shows until someone raises an area's
-- detail. ARCHITECTURE §5 is updated in the same commit.
--
--   z >= 16   assemble -> frame[0..N) -> train -> sog -> verify x3
--   z = 14    assemble -> sample -> sog
--   z <= 12   merge -> sog
--
-- `sample` is deterministic — the same scene and the same seed give the same
-- ply — so it is hash-checked on a second opinion exactly as merge and sog are.

CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap      text := world_snapshot(a_z, a_x, a_y);
    base      jsonb;
    asm       bigint;
    frames    bigint [] := '{}';
    trn       bigint;
    smp       bigint;
    mrg       bigint;
    views     int := camera_views(a_z);
    chunk     int := frame_chunk();
    i         int;
    budget    bigint := tile_budget(a_z);
BEGIN
    IF a_z >= 14 THEN
        base := jsonb_build_object(
            'snapshot', snap,
            'geo_seed', coalesce(current_setting('app.geo_seed', true), 'v1'),
            'glb', instance_glbs(a_z, a_x, a_y));
        asm := new_atom(a_job, 'assemble', 'assemble-v1', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, '{}');
    END IF;

    IF a_z >= 16 THEN
        i := 0;
        WHILE i < views LOOP
            frames := frames || new_atom(a_job, 'frame', 'frame-v1',
                jsonb_build_object('assemble', asm, 'snapshot', snap),
                jsonb_build_object('camera_set',
                        CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v1' END,
                    'from', i, 'to', least(i + chunk, views)), 0,
                ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v1',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', CASE WHEN a_z = 18 THEN 7000 ELSE 5000 END,
                'needs_webgpu', true,
                'min_vram_gb', CASE WHEN a_z = 18 THEN 4 ELSE 2 END), 0, frames);
        smp := new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
        FOR i IN 1..3 LOOP
            PERFORM new_atom(a_job, 'verify', 'verify-v1',
                jsonb_build_object('sog', smp),
                jsonb_build_object('index', i, 'min_psnr', 22), 0, ARRAY[smp]);
        END LOOP;
    ELSIF a_z = 14 THEN
        smp := new_atom(a_job, 'sample', 'sample-v1',
            jsonb_build_object('assemble', asm, 'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, ARRAY[asm]);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', smp),
            jsonb_build_object('budget', budget), 0, ARRAY[smp]);
    ELSE
        mrg := new_atom(a_job, 'merge', 'merge-v1',
            jsonb_build_object('children', child_sogs(a_z, a_x, a_y),
                               'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'voxel', 0.05, 'budget', budget), 0, '{}');
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', mrg),
            jsonb_build_object('budget', budget), 0, ARRAY[mrg]);
    END IF;
END
$$;

INSERT INTO structural_rule (op, name, rule) VALUES
('sample', 'bytes', '$3 > 0'),
('sample', 'finite', '($2 ->> ''finite'')::boolean IS true'),
('sample', 'bbox', 'bbox_fits($1, $2)'),
('sample', 'budget',
 'coalesce(($2 ->> ''splat_count'')::bigint, 0) <= (($1).params ->> ''budget'')::bigint');

-- ------------------------------------------------------------------ submit
--
-- db/0015_structural.sql's, with `sample` counted among the deterministic ops.

CREATE FUNCTION deterministic(p_op text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$SELECT p_op IN ('merge', 'sog', 'sample')$$;

CREATE OR REPLACE FUNCTION submit_atom(p_atom bigint, p_output text, p_result jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a        atom%rowtype;
    j        job%rowtype;
    wid      uuid := my_worker(NULL);
    bytes    bigint;
    broke    text;
    newstate text;
BEGIN
    SELECT * INTO a FROM atom WHERE id = p_atom FOR UPDATE;
    IF a.id IS NULL THEN
        RAISE EXCEPTION 'no such atom %', p_atom;
    END IF;
    IF a.state <> 'claimed' OR a.worker_id <> wid THEN
        RAISE EXCEPTION 'atom % is % and claimed by %, not submittable by you',
            p_atom, a.state, a.worker_id;
    END IF;
    SELECT * INTO j FROM job WHERE id = a.job_id;

    bytes := coalesce(
        (SELECT artifact.bytes FROM artifact WHERE sha256 = p_output),
        (p_result ->> 'bytes')::bigint, 0);

    broke := run_structural(a, coalesce(p_result, '{}'::jsonb), bytes);
    IF broke IS NOT NULL THEN
        INSERT INTO verification (atom_id, verifier_worker_id, kind, passed, metrics)
        VALUES (a.id, wid, 'structural', false,
                jsonb_build_object('rule', broke));
        UPDATE atom SET attempts = attempts + 1,
            state = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'ready' END,
            worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
        WHERE id = a.id RETURNING state INTO newstate;
        RETURN newstate;
    END IF;

    IF deterministic(a.op) AND a.output_sha256 IS NOT NULL THEN
        IF a.output_sha256 <> p_output THEN
            PERFORM disagreed(a, wid, p_output);
            RETURN (SELECT state FROM atom WHERE id = a.id);
        END IF;
        INSERT INTO verification (atom_id, verifier_worker_id, kind, passed, metrics)
        VALUES (a.id, wid, 'hash', true,
                jsonb_build_object('expected', a.output_sha256, 'got', p_output));
    END IF;

    INSERT INTO verification (atom_id, verifier_worker_id, kind, passed)
    VALUES (a.id, wid, 'structural', true);

    -- Trained tiles are only probabilistically verified (Invariant 8): their
    -- .sog waits for three independent perceptual checks. Everything else is
    -- deterministic and is accepted here.
    newstate := CASE WHEN a.op = 'sog' AND j.z >= 16 THEN 'submitted'
                     ELSE 'verified' END;
    UPDATE atom SET state = newstate, output_sha256 = p_output,
                    result = p_result, heartbeat_at = now()
    WHERE id = a.id;

    PERFORM advance_atoms(a.job_id);
    RETURN newstate;
END
$$;

CREATE OR REPLACE FUNCTION recheck_atom(p_atom bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a atom%rowtype;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    SELECT * INTO a FROM atom WHERE id = p_atom FOR UPDATE;
    IF a.id IS NULL OR NOT deterministic(a.op) OR a.state <> 'verified' THEN
        RETURN false;
    END IF;
    UPDATE atom SET state = 'ready', worker_id = NULL,
                    claimed_at = NULL, heartbeat_at = NULL
    WHERE id = a.id;
    UPDATE job SET state = 'open' WHERE id = a.job_id AND state = 'done';
    RETURN true;
END
$$;
