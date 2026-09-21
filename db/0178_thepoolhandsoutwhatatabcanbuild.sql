-- 0178_thepoolhandsoutwhatatabcanbuild.sql — a tab is handed only pieces it
-- can build, a job left behind by a version bump is reopened at the new one,
-- and a piece in a tab's hands is not taken out of them by a rebuild.
--
-- What was seen, after the trainer moved to train-v14 (db/0174): a page still
-- serving train-v13 claimed every train piece in the world, refused each one
-- with "compile the tile again to get one it can build", and fail_atom counted
-- every refusal as an attempt. Three refusals and the atom was `failed`, the
-- job gave up, and the tile said so. Thousands of them, and the advice was
-- wrong twice over: the tile was fine, the tab was stale; and compiling again
-- opened a job at the same versions the tab could not build.
--
-- Three holes, closed here:
--
--   * claim_atom never looked at what the tab said it builds. `caps.algo` has
--     travelled with every claim since client/js/workcaps.js existed and was
--     never read. It is read now: a piece whose algo_version is not the one
--     the tab names for that op is not that tab's to claim. A tab that names
--     nothing is trusted as before.
--   * A migration that bumps build_dag's versions leaves every open job at the
--     old ones, and ensure_job — the same (tile, version), so the same job —
--     never rebuilds a DAG. `refresh_stale_jobs` finds the open jobs with work
--     left in them at a version build_dag no longer makes, cancels them, and
--     opens the job again at the same target_version: verified atoms at
--     versions that did not move are reused by their atom_hash (Invariant 2),
--     so a tile whose frames are done is not re-framed. `algo_current` is the
--     one place the versions are written; db/test holds build_dag to it, and
--     client/test/algo.test.js holds the tab to it. Run once here for the
--     jobs already stranded, and to be run by every migration that bumps a
--     version from now on. An admin may run it from the page as well.
--   * new_atom, adopting an unfinished atom out of a cancelled job into the
--     job that asks for it now, reset it — worker, claim, output — while a tab
--     was in the middle of it. The tab's next heartbeat was refused, its
--     upload got 403, and submit_atom said "claimed by <somebody else>, not
--     submittable by you". A claim that is still beating moves with the atom
--     now; only a quiet one is reset.
--
-- Invariant 4 holds: ensure_job is still the only thing that opens a job.
-- Invariant 2 holds: no atom's identity changes; stale ones are left in their
-- cancelled job and new ones are made at the new version.

-- ------------------------------------------------ what the world builds now

-- The version build_dag (db/0174) makes of each op. Written once, here, and
-- held to build_dag by db/test/0178.
CREATE FUNCTION algo_current(p_op text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE p_op
    WHEN 'assemble' THEN 'assemble-v11'
    WHEN 'frame' THEN 'frame-v10'
    WHEN 'train' THEN 'train-v14'
    WHEN 'merge' THEN 'merge-v1'
    WHEN 'sog' THEN 'sog-v3'
    WHEN 'verify' THEN 'verify-v1' END;
$$;

GRANT EXECUTE ON FUNCTION algo_current(text) TO anon, player, admin;

-- ---------------------------------------------- the tab claims what it builds

-- Whether a tab that reports `caps.algo` builds this atom's version. A tab
-- that reports nothing for the op is not held to anything.
CREATE FUNCTION atom_builds(a atom, p_caps jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
SELECT p_caps -> 'algo' ->> a.op IS NULL
    OR p_caps -> 'algo' ->> a.op = a.algo_version;
$$;

REVOKE ALL ON FUNCTION atom_builds(atom, jsonb) FROM PUBLIC;

-- db/0083's claim_atom, asking atom_builds as well.
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
      AND atom_builds(a2, p_caps)
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

-- db/0083's claim_for, the same way.
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

-- ------------------------------------------ a piece in hand stays in hand

-- db/0100's new_atom: a claim that is still beating moves with the atom.
CREATE OR REPLACE FUNCTION new_atom(a_job bigint, a_op text, a_algo text, a_inputs jsonb,
                                    a_params jsonb, a_seed int, a_deps bigint [])
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    h   text := atom_hash(a_op, a_algo, a_inputs, a_params, a_seed);
    aid bigint;
    have atom%rowtype;
BEGIN
    INSERT INTO atom (job_id, atom_hash, op, algo_version, deps, inputs,
                      params, seed, state)
    VALUES (a_job, h, a_op, a_algo, a_deps, a_inputs, a_params, a_seed,
            CASE WHEN cardinality(a_deps) = 0 THEN 'ready' ELSE 'waiting' END)
    ON CONFLICT (atom_hash) DO NOTHING
    RETURNING id INTO aid;
    IF aid IS NOT NULL THEN
        RETURN aid;
    END IF;

    -- Identical computation already exists; reuse it rather than repeat it.
    SELECT * INTO have FROM atom WHERE atom_hash = h FOR UPDATE;
    IF have.job_id = a_job THEN
        RETURN have.id;
    END IF;
    IF have.state <> 'failed' AND EXISTS (
        SELECT 1 FROM job j WHERE j.id = have.job_id AND j.state = 'open') THEN
        -- Another open job is doing it; this one shares the answer
        -- (advance_dependants, db/0094).
        RETURN have.id;
    END IF;
    IF have.state = 'verified' THEN
        UPDATE atom SET job_id = a_job, deps = a_deps WHERE id = have.id;
        RETURN have.id;
    END IF;
    -- In a tab's hands, and the tab is still saying so: the work is going on
    -- and this job is the one it is going on for now. Resetting it here is
    -- what made a tab's heartbeat, upload and submit all refused mid-run.
    IF have.state = 'claimed'
       AND coalesce(have.heartbeat_at, have.claimed_at)
           >= now() - claim_patience(have.op) THEN
        UPDATE atom SET job_id = a_job, deps = a_deps WHERE id = have.id;
        RETURN have.id;
    END IF;
    -- Unfinished, or failed: starts again here. Every state but verified may
    -- go to ready; ready may go to waiting (db/0005_state.sql).
    UPDATE atom SET state = 'ready', job_id = a_job, deps = a_deps,
        attempts = 0, handed_back = 0, worker_id = NULL, claimed_at = NULL,
        heartbeat_at = NULL, output_sha256 = NULL, result = NULL
    WHERE id = have.id AND state <> 'ready';
    IF cardinality(a_deps) > 0 THEN
        UPDATE atom SET state = 'waiting', job_id = a_job, deps = a_deps WHERE id = have.id;
    ELSE
        UPDATE atom SET job_id = a_job, deps = a_deps WHERE id = have.id;
    END IF;
    RETURN have.id;
END
$$;

-- ---------------------------------- a job at a version nobody builds any more

-- The open jobs with work left in them at a version build_dag no longer
-- makes, reopened at the versions it does. Returns how many were reopened.
CREATE FUNCTION refresh_stale_jobs() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    j record;
    n int := 0;
BEGIN
    PERFORM set_config('splatworld.rebuild', '1', true);
    -- Coarse before fine (db/0010_lockorder.sql).
    FOR j IN SELECT job.id, job.z, job.x, job.y FROM job
             WHERE job.state = 'open'
               AND EXISTS (SELECT 1 FROM atom a
                           WHERE a.job_id = job.id AND a.state <> 'verified'
                             AND a.algo_version IS DISTINCT FROM algo_current(a.op))
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

REVOKE ALL ON FUNCTION refresh_stale_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_stale_jobs() TO admin;

CREATE FUNCTION api.refresh_stale_jobs() RETURNS int
LANGUAGE plpgsql VOLATILE SET search_path = public AS $$
BEGIN
    IF current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin reopens the world''s jobs' USING errcode = '42501';
    END IF;
    RETURN public.refresh_stale_jobs();
END
$$;

GRANT EXECUTE ON FUNCTION api.refresh_stale_jobs() TO admin;

-- The jobs this world already has at versions it no longer builds.
SELECT refresh_stale_jobs();
