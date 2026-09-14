-- 0083_thetrainerasksforwhatitcanbeasked.sql — the capability gate stops asking
-- for a number no browser can answer.
--
-- db/0017_verifydag.sql gave the train atom `min_vram_gb`: 4 at z18, 2 at z16.
-- Nothing on the client can answer that. WebGPU reports no VRAM at all, so
-- client/js/work.js estimated it from `adapter.limits.maxBufferSize`, which is
-- not the card's memory but a limit the browser caps — 1 GiB under Dawn's
-- SwiftShader here, 2 GiB on most desktops. Rounded to whole gigabytes that is
-- 1 or 2, so `min_vram_gb >= 4` was false on every machine anybody has run
-- this on: a z18 job assembled, framed six times and then stopped with two
-- pieces left, the panel saying "needs WebGPU" beside a tab that had it.
-- client/test/e2e/train.spec.js had already worked around it by building its
-- own atom with `min_vram_gb: 1`.
--
-- What the trainer actually needs of the device is a buffer big enough for its
-- widest per-splat array: `pre`, 24 f32 per splat (client/lib/gsgpu.js,
-- client/lib/gswgsl.js STRIDE). That is 96 bytes × the tile's budget, and it
-- is exactly what `maxBufferSize` is the limit on — a question the adapter
-- answers rather than one it is guessed at.
--
-- Invariant 2 is why the fix is here and not in the rows: an atom's params are
-- immutable, so the jobs already stuck carry `min_vram_gb` for ever. The gate
-- stops reading it instead, and they become claimable again.

-- The largest single buffer this atom will ask the device for, in whole MB.
-- Only training allocates per-splat arrays on the GPU; every other op runs on
-- WebGL2 or on the CPU.
CREATE FUNCTION atom_buffer_mb(a atom) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE WHEN a.op = 'train'
            THEN ceil(coalesce((a.params ->> 'min_buffer_mb')::numeric,
                               96 * coalesce((a.params ->> 'budget')::numeric, 0)
                               / 1048576))
            ELSE 0 END;
$$;

-- Whether a tab that says this about itself can take this atom. A tab that
-- says nothing about its buffers is let through: the gate exists to keep work
-- off a machine that has answered that it cannot hold it, not to hold work
-- back from every machine that has not been asked. The atom fails honestly on
-- that machine if the answer was wrong, and three failures stop it.
CREATE FUNCTION atom_fits(a atom, p_caps jsonb) RETURNS boolean
LANGUAGE sql STABLE AS $$
SELECT (NOT coalesce((a.params ->> 'needs_webgpu')::boolean, false)
        OR coalesce((p_caps ->> 'webgpu')::boolean, false))
   AND (p_caps ->> 'max_buffer_mb' IS NULL
        OR (p_caps ->> 'max_buffer_mb')::numeric >= atom_buffer_mb(a));
$$;

REVOKE ALL ON FUNCTION atom_buffer_mb(atom), atom_fits(atom, jsonb) FROM PUBLIC;
-- render_pool is plain SQL and runs as its caller, and the row it builds says
-- how big a buffer the job needs, so the roles that may read the pool may ask
-- this arithmetic. atom_fits stays inside the two SECURITY DEFINER claims.
GRANT EXECUTE ON FUNCTION atom_buffer_mb(atom) TO anon, player, admin;

-- ------------------------------------------------------- the two claim paths

-- db/0060_crssaysitonce.sql's claim_atom, with the VRAM comparison replaced.
CREATE OR REPLACE FUNCTION claim_atom(p_caps jsonb DEFAULT '{}'::jsonb) RETURNS atom
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid   uuid;
    trust numeric;
    a     atom%rowtype;
    ops   text [] := CASE WHEN jsonb_typeof(p_caps -> 'ops') = 'array'
                          THEN ARRAY(SELECT jsonb_array_elements_text(p_caps -> 'ops')) END;
    near  geometry := CASE WHEN jsonb_typeof(p_caps -> 'near') = 'object'
                           THEN st_setsrid(st_makepoint(
                               (p_caps -> 'near' ->> 'lon')::double precision,
                               (p_caps -> 'near' ->> 'lat')::double precision), world_srid()) END;
BEGIN
    PERFORM expire_claims();
    wid := my_worker(p_caps);
    SELECT w.trust INTO trust FROM worker w WHERE w.id = wid;

    SELECT a2.* INTO a
    FROM atom a2
    INNER JOIN job j ON j.id = a2.job_id AND j.state = 'open'
    INNER JOIN tile t ON t.z = j.z AND t.x = j.x AND t.y = j.y
    WHERE a2.state = 'ready'
      AND j.target_version = t.expected_version
      AND (ops IS NULL OR a2.op = ANY(ops))
      AND atom_fits(a2, p_caps)
      AND coalesce(trust, 0) >= trust_min(a2.op)
      AND (a2.op <> 'verify' OR may_verify(a2.job_id, a2.id, wid))
      AND (a2.op <> 'merge' OR merge_has_a_child(a2.inputs))
    ORDER BY j.bounty DESC,
        CASE WHEN near IS NULL THEN 0
             ELSE st_distance(st_centroid(tile_bbox(j.z, j.x, j.y)), near) END,
        a2.id
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

-- db/0070_therebuildopensitself.sql's claim_for, the same way.
CREATE OR REPLACE FUNCTION claim_for(p_job bigint, p_caps jsonb DEFAULT '{}'::jsonb)
RETURNS atom
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid uuid;
    a   atom%rowtype;
BEGIN
    PERFORM expire_claims();
    wid := my_worker(p_caps);

    SELECT a2.* INTO a
    FROM atom a2
    INNER JOIN job j ON j.id = a2.job_id AND j.state = 'open'
    INNER JOIN tile t ON t.z = j.z AND t.x = j.x AND t.y = j.y
    WHERE a2.job_id = p_job
      AND a2.state = 'ready'
      AND j.target_version = t.expected_version
      AND (a2.op <> 'merge' OR merge_has_a_child(a2.inputs))
      AND atom_fits(a2, p_caps)
    ORDER BY a2.id
    FOR UPDATE OF a2 SKIP LOCKED
    LIMIT 1;

    IF a.id IS NULL THEN
        RETURN NULL;
    END IF;
    UPDATE atom SET state = 'claimed', worker_id = wid,
                    claimed_at = now(), heartbeat_at = now()
    WHERE atom.id = a.id RETURNING * INTO a;
    RETURN a;
END
$$;

-- ------------------------------------------------------ what the DAG asks for

-- db/0080_onesky.sql's build_dag, asking the train atom for the buffer it will
-- allocate rather than for a card's memory. Everything else is untouched.
CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v1' END;
    leaf   boolean := is_leaf_tile(a_z, a_x, a_y);
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
    IF leaf THEN
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        asm := new_atom(a_job, 'assemble', 'assemble-v2', base,
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
            jsonb_build_object('budget', budget,
                'iters', CASE WHEN a_z = 18 THEN 7000 ELSE 5000 END,
                'camera_set', cams,
                'needs_webgpu', true,
                -- The widest per-splat array the trainer allocates: 24 f32 a
                -- splat (client/lib/gswgsl.js STRIDE), which is what
                -- adapter.limits.maxBufferSize is the limit on.
                'min_buffer_mb', ceil(96::numeric * budget / 1048576)), 0, frames);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
    ELSIF leaf THEN
        smp := new_atom(a_job, 'sample', 'sample-v3',
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

-- ------------------------------------------------------- and the pool says it

-- db/0079_worktakenandgivenback.sql's render_pool, with the one number the row
-- needs to say "this tab cannot hold it" instead of "needs WebGPU" beside a
-- tab that has WebGPU (client/js/poolui.js).
CREATE OR REPLACE FUNCTION render_pool(p_lon double precision DEFAULT null,
                                       p_lat double precision DEFAULT null,
                                       p_limit int DEFAULT 40) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(j ORDER BY j ->> 'ordering'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object(
        'job', job.id, 'z', job.z, 'x', job.x, 'y', job.y,
        'bounty', job.bounty, 'version', job.target_version,
        'opened_at', job.created_at,
        'ready', (SELECT count(*) FROM atom a
                  WHERE a.job_id = job.id AND a.state IN ('ready', 'waiting')),
        'claimed', (SELECT count(*) FROM atom a
                    WHERE a.job_id = job.id AND a.state = 'claimed'),
        'failed', (SELECT count(*) FROM atom a
                   WHERE a.job_id = job.id AND a.state = 'failed'),
        'handed_back', (SELECT coalesce(sum(a.handed_back), 0) FROM atom a
                        WHERE a.job_id = job.id),
        'may_retry', may_retry_job(job.id),
        'made', CASE
            WHEN EXISTS (SELECT 1 FROM atom a
                         WHERE a.job_id = job.id AND a.op = 'train') THEN 'trained'
            WHEN EXISTS (SELECT 1 FROM atom a
                         WHERE a.job_id = job.id AND a.op = 'assemble') THEN 'assembled'
            ELSE 'merged from its children' END,
        'needs_webgpu', EXISTS (
            SELECT 1 FROM atom a WHERE a.job_id = job.id
              AND coalesce((a.params ->> 'needs_webgpu')::boolean, false)),
        'needs_mb', (SELECT coalesce(max(atom_buffer_mb(a)), 0) FROM atom a
                     WHERE a.job_id = job.id
                       AND a.state IN ('ready', 'waiting', 'claimed', 'failed')),
        'metres', CASE WHEN p_lon IS null THEN null ELSE
            st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                        st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography) END,
        'ordering', lpad((1000000 - least(job.bounty, 999999))::bigint::text, 9, '0')
            || lpad(coalesce(CASE WHEN p_lon IS null THEN 0 ELSE
                st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                            st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography)
                END, 0)::bigint::text, 12, '0')
            || lpad((18 - job.z)::text, 2, '0')) AS j
    FROM job
    INNER JOIN tile t ON t.z = job.z AND t.x = job.x AND t.y = job.y
    WHERE job.state = 'open'
      AND job.target_version = t.expected_version
      AND EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                  AND a.state IN ('ready', 'waiting', 'claimed', 'failed'))
      AND NOT EXISTS (SELECT 1 FROM atom a
                      WHERE a.job_id = job.id AND a.op = 'merge'
                        AND a.state IN ('ready', 'waiting')
                        AND NOT merge_has_a_child(a.inputs))
    ORDER BY job.bounty DESC, job.id
    LIMIT greatest(p_limit, 0)
) pool;
$$;
