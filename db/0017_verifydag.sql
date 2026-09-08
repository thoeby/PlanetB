-- 0017_verifydag.sql — WP3.2 continued: the DAG and the claim rules that make
-- three independent checks independent.
--
--   * a verify atom is given the frames as well as the .sog, because it has to
--     render the poses those frames were rendered from;
--   * it names its camera set, so the atom can work out which two of the four
--     held-out poses are its pair (client/atoms/verify.js);
--   * and nobody may check their own work, or check the same tile twice.

-- How many tabs have to agree about a tile. The trained ply's atom is the
-- argument because WP3.4 lowers the count for a trainer the world already
-- trusts; until then it is three, whoever trains.
CREATE FUNCTION verify_count(p_train bigint) RETURNS int
LANGUAGE sql STABLE AS $$
SELECT greatest(coalesce(current_setting('app.verify_min', true)::int, 3), 1);
$$;

CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v1' END;
    base   jsonb;
    asm    bigint;
    frames bigint [] := '{}';
    trn    bigint;
    smp    bigint;
    mrg    bigint;
    views  int := camera_views(a_z);
    chunk  int := frame_chunk();
    i      int;
    budget bigint := tile_budget(a_z);
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
                jsonb_build_object('camera_set', cams,
                    'from', i, 'to', least(i + chunk, views)), 0, ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v1',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget, 'camera_set', cams,
                'iters', CASE WHEN a_z = 18 THEN 7000 ELSE 5000 END,
                'needs_webgpu', true,
                'min_vram_gb', CASE WHEN a_z = 18 THEN 4 ELSE 2 END), 0, frames);
        smp := new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
        FOR i IN 1..verify_count(trn) LOOP
            PERFORM new_atom(a_job, 'verify', 'verify-v1',
                jsonb_build_object('sog', smp, 'frames', to_jsonb(frames)),
                jsonb_build_object('index', i, 'min_psnr', 22, 'camera_set', cams,
                                   'require_distinct_workers', true), 0, ARRAY[smp]);
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

-- ------------------------------------------------------------------- claim

CREATE OR REPLACE FUNCTION claim_atom(p_caps jsonb DEFAULT '{}'::jsonb) RETURNS atom
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid uuid;
    a   atom%rowtype;
BEGIN
    PERFORM expire_claims();
    wid := my_worker(p_caps);

    SELECT a2.* INTO a
    FROM atom a2
    JOIN job j ON j.id = a2.job_id AND j.state = 'open'
    WHERE a2.state = 'ready'
      AND (NOT coalesce((a2.params ->> 'needs_webgpu')::boolean, false)
           OR coalesce((p_caps ->> 'webgpu')::boolean, false))
      AND coalesce((a2.params ->> 'min_vram_gb')::numeric, 0)
          <= coalesce((p_caps ->> 'vram_gb')::numeric, 0)
      -- Invariant 8: three *independent* opinions, so not the tab that made it
      -- and not a tab that has already given one for this tile.
      AND (a2.op <> 'verify' OR may_verify(a2.job_id, a2.id, wid))
    ORDER BY j.bounty DESC, a2.id
    FOR UPDATE OF a2 SKIP LOCKED
    LIMIT 1;

    IF a.id IS NULL THEN
        RETURN NULL;
    END IF;

    UPDATE atom SET state = 'claimed', worker_id = wid,
                    claimed_at = now(), heartbeat_at = now()
    WHERE id = a.id RETURNING * INTO a;
    RETURN a;
END
$$;

-- ------------------------------------------------------------------ submit
--
-- db/0016_sample.sql's, with one addition: a verify atom's answer is not only
-- its own result, it is an opinion about the .sog it depends on, and
-- submit_verification is where that opinion is counted.

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

    newstate := CASE WHEN a.op = 'sog' AND j.z >= 16 THEN 'submitted'
                     ELSE 'verified' END;
    UPDATE atom SET state = newstate, output_sha256 = p_output,
                    result = p_result, heartbeat_at = now()
    WHERE id = a.id;

    PERFORM advance_atoms(a.job_id);
    IF a.op = 'verify' THEN
        PERFORM submit_verification((a.inputs ->> 'sog')::bigint,
            coalesce((p_result ->> 'passed')::boolean, false),
            coalesce(p_result, '{}'::jsonb));
    END IF;
    RETURN newstate;
END
$$;

INSERT INTO structural_rule (op, name, rule) VALUES
('verify', 'answer', 'jsonb_typeof($2 -> ''passed'') = ''boolean'''),
('verify', 'psnr', 'jsonb_typeof($2 -> ''psnr'') = ''number'''),
('verify', 'poses',
 'jsonb_typeof($2 -> ''poses'') = ''array''
  AND jsonb_array_length($2 -> ''poses'') >= 2');
