-- 0182_thetileisseenfromafar.sql — the tile is framed from afar and low as
-- well as from close and above, and a job framed the old way is reopened.
--
-- What the trained tile looked like from where a player stands: the terrain
-- readable where a station had looked at it, and blobs everywhere else.
-- z16-v2's 45 frames all see the ground from nearby and from 55° or straight
-- above (db/0125); nothing in the set looks across the tile from far off and
-- low, so the trainer matched every frame it was shown and was held to
-- nothing from the angle the world is actually seen at.
--
-- z16-v3 keeps the stations and adds three rings of twelve at 1.8 extents
-- out, at 12°, 25° and 40° (client/lib/cameras.js): 81 views, five frame
-- atoms of twenty. The camera set travels in the frame and train params, so
-- every z14–z20 tile is framed and trained again (Invariant 2: a different
-- computation is a different atom). z18 keeps z18-v1, which already has rings.
--
-- camera_set_current is the one place the set is named, beside algo_current
-- (db/0178), and the stale-job check reads both: a job whose frames were
-- traced from the old set is reopened the way a job at an old version is.

CREATE FUNCTION camera_set_current(p_z int) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE WHEN p_z = 18 THEN 'z18-v1' ELSE 'z16-v3' END;
$$;

GRANT EXECUTE ON FUNCTION camera_set_current(int) TO anon, player, admin;

-- db/0136's camera_views: 81 for every zoom framed from z16-v3.
CREATE OR REPLACE FUNCTION camera_views(z int) RETURNS int
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE z WHEN 18 THEN 120 WHEN 20 THEN 81 WHEN 16 THEN 81 WHEN 14 THEN 81 ELSE 0 END;
$$;

-- Whether an atom is one build_dag would still make: at the current version
-- of its op, and, for a frame or a trainer, from the current camera set.
CREATE FUNCTION atom_current(a atom, p_z int) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
SELECT a.algo_version IS NOT DISTINCT FROM algo_current(a.op)
   AND (a.op NOT IN ('frame', 'train')
        OR a.params ->> 'camera_set' IS NOT DISTINCT FROM camera_set_current(p_z));
$$;

REVOKE ALL ON FUNCTION atom_current(atom, int) FROM PUBLIC;

-- db/0179's stale_work_waiting, asking atom_current.
CREATE OR REPLACE FUNCTION stale_work_waiting() RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT EXISTS (
    SELECT 1 FROM atom a
    INNER JOIN job j ON j.id = a.job_id AND j.state = 'open'
    WHERE a.state = 'ready' AND NOT atom_current(a, j.z));
$$;

-- db/0178's refresh_stale_jobs, the same.
CREATE OR REPLACE FUNCTION refresh_stale_jobs() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    j record;
    n int := 0;
BEGIN
    PERFORM set_config('splatworld.rebuild', '1', true);
    FOR j IN SELECT job.id, job.z, job.x, job.y FROM job
             WHERE job.state = 'open'
               AND EXISTS (SELECT 1 FROM atom a
                           WHERE a.job_id = job.id AND a.state <> 'verified'
                             AND NOT atom_current(a, job.z))
             ORDER BY job.z, job.x, job.y LOOP
        UPDATE job SET state = 'cancelled' WHERE id = j.id;
        PERFORM refund_bounty(j.id);
        PERFORM ensure_job(j.z, j.x, j.y);
        n := n + 1;
    END LOOP;
    PERFORM set_config('splatworld.rebuild', '', true);
    RETURN n;
END
$$;

-- db/0179's claim_for, asking atom_current about the job it was handed.
CREATE OR REPLACE FUNCTION claim_for(p_job bigint, p_caps jsonb DEFAULT '{}'::jsonb)
RETURNS atom
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid uuid;
    a   atom%rowtype;
    j   job%rowtype;
    t   tile%rowtype;
BEGIN
    PERFORM expire_claims();
    wid := my_worker(p_caps);

    SELECT * INTO j FROM job WHERE id = p_job;
    IF p_caps ? 'algo' AND j.id IS NOT NULL AND EXISTS (
        SELECT 1 FROM atom a2 WHERE a2.job_id = j.id AND a2.state <> 'verified'
          AND NOT atom_current(a2, j.z)) THEN
        PERFORM refresh_stale_jobs();
        SELECT * INTO t FROM tile WHERE z = j.z AND x = j.x AND y = j.y;
        p_job := coalesce(live_job(j.z, j.x, j.y, t.expected_version), p_job);
    END IF;

    SELECT a2.* INTO a
    FROM atom a2
    INNER JOIN job j2 ON j2.id = a2.job_id AND j2.state = 'open'
    INNER JOIN tile t2 ON t2.z = j2.z AND t2.x = j2.x AND t2.y = j2.y
    WHERE a2.job_id = p_job
      AND a2.state = 'ready'
      AND j2.target_version = t2.expected_version
      AND (a2.op <> 'merge' OR merge_has_a_child(a2.inputs))
      AND atom_fits(a2, p_caps)
      AND atom_builds(a2, p_caps)
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

-- db/0174's build_dag, naming its cameras through camera_set_current.
CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := camera_set_current(a_z);
    leaf   boolean := is_leaf_tile(a_z, a_x, a_y);
    base   jsonb;
    asm    bigint;
    frames bigint [] := '{}';
    trn    bigint;
    mrg    bigint;
    views  int := coalesce(nullif(camera_views(a_z), 0), camera_views(14));
    chunk  int := frame_chunk();
    i      int;
    budget bigint := job_budget(a_z);
    px     int := frame_px();
    how    jsonb := frame_renderer();
BEGIN
    IF leaf THEN
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        asm := new_atom(a_job, 'assemble', 'assemble-v11', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, '{}');
        i := 0;
        WHILE i < views LOOP
            frames := frames || new_atom(a_job, 'frame', 'frame-v10',
                jsonb_build_object('assemble', asm, 'snapshot', snap),
                jsonb_build_object('camera_set', cams, 'size', px,
                    'from', i, 'to', least(i + chunk, views)) || how, 0, ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v14',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                -- Of the budget, seeded on the surface. A tenth: measured,
                -- not reasoned. See the header.
                'seed_share', 0.1,
                -- And how much of that seed is spent on the ground itself,
                -- whatever else is standing on the tile. Two thirds: see the
                -- header.
                'ground_floor', 0.66,
                -- How much wider every trained splat is written than the
                -- trainer settled on. One: it was 1.3 on top of a seed sigma
                -- that was already four times too big, and widening is for a
                -- tile that is short of splats, not one whose splats are too
                -- large to begin with (client/atoms/train.js SPREAD).
                'scale', 1,
                -- How often brush looks for splats to split. Thirty rather
                -- than twenty: a pass reads the gradient built up since the
                -- last one, and twenty steps of it was a noisier signal that
                -- yielded 5.1 % where brush's own interval yields 10.4 %. The
                -- longer run has forty-eight passes at thirty anyway.
                'refine_every', 30,
                'needs_webgpu', true,
                'min_buffer_mb', ceil(96::numeric * budget / 1048576)), 0, frames);
        PERFORM new_atom(a_job, 'sog', 'sog-v3', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
    ELSE
        mrg := new_atom(a_job, 'merge', 'merge-v1',
            jsonb_build_object('children', child_sogs(a_z, a_x, a_y),
                               'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'voxel', 0.05, 'budget', budget), 0, '{}');
        PERFORM new_atom(a_job, 'sog', 'sog-v3', jsonb_build_object('ply', mrg),
            jsonb_build_object('budget', budget), 0, ARRAY[mrg]);
    END IF;
END
$$;

-- The jobs this world already has, framed the old way.
SELECT refresh_stale_jobs();
