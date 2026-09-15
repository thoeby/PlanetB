-- 0100_ajobownswhatitasksfor.sql — a job owns the atoms it asks for, and a
-- job whose work is already done publishes.
--
-- What was seen: a tile approved, "1 render job in the pool", and a pool
-- with nothing in it. The job had no atoms. Every atom build_dag asked for —
-- assemble, sample, sog — already existed, verified, from the job before on
-- the same tile at the same inputs (content-addressing, Invariant 2), and
-- db/0094 left a verified atom where it sat. Nothing pointed at the new job:
-- nobody would claim, nobody would publish, and the tile said "queued" for
-- ever. Compile it all again on ground nobody changed hits this every time.
--
-- Two rules:
--   1. An atom in a job that is not open moves to the job that asks for it,
--      whatever its state. Verified stays verified, with its output — the
--      work is done and this job is the one it was done for now.
--   2. A job that, once built, has no work left (every atom verified) is
--      published there and then from its verified sog (revive_job, db/0081),
--      instead of waiting for a worker that will never come.
-- Invariant 4 holds: no job or atom is created anywhere new. Invariant 3
-- holds: the publish is still publish_sog's compare-and-swap.
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

-- db/0094's ensure_job, publishing a job that is built with nothing left to do.
CREATE OR REPLACE FUNCTION ensure_job(z int, x int, y int,
                                      bounty numeric DEFAULT 0)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    t   tile%rowtype;
    jid bigint;
    old bigint;
BEGIN
    SELECT * INTO t FROM tile
    WHERE tile.z = ensure_job.z AND tile.x = ensure_job.x AND tile.y = ensure_job.y;
    IF t.z IS null THEN
        RAISE EXCEPTION 'no such tile %/%/%', z, x, y;
    END IF;
    IF t.expected_version = 0 THEN
        RAISE EXCEPTION 'tile %/%/% has no world input yet', z, x, y;
    END IF;

    IF bounty <= 0
       AND current_user_role() <> 'admin'
       AND coalesce(current_setting('splatworld.rebuild', true), '') <> '1'
       AND NOT EXISTS (
           SELECT 1 FROM area
           WHERE st_intersects(area.geom, tile_bbox(z, x, y))
             AND is_area_writer(area.id)) THEN
        RAISE EXCEPTION 'not authorised for %/%/% and no bounty attached', z, x, y;
    END IF;

    SELECT id INTO jid FROM job
    WHERE job.z = ensure_job.z AND job.x = ensure_job.x AND job.y = ensure_job.y
      AND job.target_version = t.expected_version;
    IF jid IS NOT null THEN
        IF NOT job_can_work(jid)
           AND t.published_version < t.expected_version THEN
            PERFORM revive_job(jid);
        END IF;
        RETURN jid;
    END IF;

    FOR old IN SELECT id FROM job
               WHERE job.z = ensure_job.z AND job.x = ensure_job.x
                 AND job.y = ensure_job.y AND job.state = 'open'
                 AND job.target_version < t.expected_version LOOP
        UPDATE job SET state = 'cancelled' WHERE id = old;
        PERFORM refund_bounty(old);
    END LOOP;

    INSERT INTO job (z, x, y, target_version)
    VALUES (z, x, y, t.expected_version) RETURNING id INTO jid;
    PERFORM build_dag(jid, z, x, y);
    -- A dependency verified before this job existed is still verified.
    PERFORM advance_atoms(jid);
    -- Everything it asked for was already done: publish it now.
    IF NOT job_can_work(jid) THEN
        PERFORM revive_job(jid);
    END IF;
    IF bounty > 0 THEN
        PERFORM set_bounty(jid, bounty);
    END IF;
    RETURN jid;
END
$$;
