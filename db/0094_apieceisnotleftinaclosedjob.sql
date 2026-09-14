-- 0094_apieceisnotleftinaclosedjob.sql — a job built over an atom that
-- belongs to a closed job takes the atom with it.
--
-- new_atom is content-addressed (Invariant 2): the same op, algo, inputs,
-- params and seed is the same atom, wherever it is asked for, and a second job
-- that asks is handed the first job's row. That is right when the row is
-- verified — the work is done and shared. It was wrong in every other state.
--
-- "Compile it all again" on ground nobody had changed bumped the tile's
-- version, cancelled the job, and opened a new one whose assemble atom hashed
-- to exactly the cancelled job's assemble — still `ready` (or `claimed`, or
-- `failed`) in a job claim_atom will never look at. The new job's eight other
-- atoms waited on it for ever: "8 waiting on the rest · no GPU needed", and
-- nothing anybody could press. The same happened to a job whose shared atom
-- was already verified, for a different reason: build_dag inserts every
-- dependent as `waiting` and nothing advanced it.
--
-- Three changes, Invariant 4 untouched — no job or atom is created anywhere
-- new, and ensure_job is as idempotent as it was:
--   1. new_atom adopts an unfinished atom out of a job that is not open (or
--      one that has failed anywhere): it moves to the asking job and starts
--      again from `ready`. An unfinished atom in another *open* job stays
--      where it is — that job's tab is doing it.
--   2. When an atom is verified, every open job with an atom waiting on it is
--      advanced, not only its own.
--   3. ensure_job advances the job it just built, so a dependency that was
--      verified before the job existed counts.

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
    IF have.job_id <> a_job AND have.state <> 'verified'
       AND (have.state = 'failed' OR NOT EXISTS (
           SELECT 1 FROM job j WHERE j.id = have.job_id AND j.state = 'open')) THEN
        UPDATE atom SET job_id = a_job, deps = a_deps,
            state = CASE WHEN cardinality(a_deps) = 0 THEN 'ready' ELSE 'waiting' END,
            attempts = 0, handed_back = 0, worker_id = NULL, claimed_at = NULL,
            heartbeat_at = NULL, output_sha256 = NULL, result = NULL
        WHERE id = have.id;
    END IF;
    RETURN have.id;
END
$$;

-- Every open job with an atom waiting on this one, advanced.
CREATE FUNCTION advance_dependants(p_atom bigint) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    j bigint;
BEGIN
    FOR j IN SELECT DISTINCT a.job_id FROM atom a
             INNER JOIN job jb ON jb.id = a.job_id AND jb.state = 'open'
             WHERE p_atom = ANY (a.deps) LOOP
        PERFORM advance_atoms(j);
    END LOOP;
END
$$;

-- db/0044_permission.sql's submit_atom, advancing every job that waits on the
-- atom and not only the one it belongs to.
CREATE OR REPLACE FUNCTION submit_atom(p_atom bigint, p_output text, p_result jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a     atom%rowtype;
    wid   uuid := my_worker(NULL);
    bytes bigint;
    broke text;
BEGIN
    SELECT * INTO a FROM atom WHERE atom.id = p_atom FOR UPDATE;
    IF a.id IS NULL THEN
        RAISE EXCEPTION 'no such atom %', p_atom;
    END IF;
    IF a.state <> 'claimed' OR a.worker_id <> wid THEN
        RAISE EXCEPTION 'atom % is % and claimed by %, not submittable by you',
            p_atom, a.state, a.worker_id;
    END IF;

    bytes := coalesce(
        (SELECT artifact.bytes FROM artifact WHERE sha256 = p_output),
        (p_result ->> 'bytes')::bigint, 0);

    broke := run_structural(a, coalesce(p_result, '{}'::jsonb), bytes);
    IF broke IS NOT NULL THEN
        INSERT INTO verification (atom_id, verifier_worker_id, kind, passed, metrics)
        VALUES (a.id, wid, 'structural', false, jsonb_build_object('rule', broke));
        UPDATE atom SET attempts = attempts + 1,
            state = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'ready' END,
            worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
        WHERE atom.id = a.id;
        RETURN (SELECT state FROM atom WHERE atom.id = a.id);
    END IF;

    -- Deterministic ops still have to agree with themselves: two answers for
    -- one atom_hash and neither is trusted (db/0016_sample.sql).
    IF deterministic(a.op) AND a.output_sha256 IS NOT NULL THEN
        IF a.output_sha256 <> p_output THEN
            PERFORM disagreed(a, wid, p_output);
            RETURN (SELECT state FROM atom WHERE atom.id = a.id);
        END IF;
        INSERT INTO verification (atom_id, verifier_worker_id, kind, passed, metrics)
        VALUES (a.id, wid, 'hash', true,
                jsonb_build_object('expected', a.output_sha256, 'got', p_output));
    END IF;

    INSERT INTO verification (atom_id, verifier_worker_id, kind, passed)
    VALUES (a.id, wid, 'structural', true);

    PERFORM credit(wid, trust_work());
    PERFORM record_ok(wid, a.op);

    UPDATE atom SET state = 'verified', output_sha256 = p_output,
                    result = p_result, heartbeat_at = now()
    WHERE atom.id = a.id;

    PERFORM advance_atoms(a.job_id);
    PERFORM advance_dependants(a.id);
    RETURN 'verified';
END
$$;

-- db/0081_compileitagain.sql's ensure_job, advancing the job it built.
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
    IF bounty > 0 THEN
        PERFORM set_bounty(jid, bounty);
    END IF;
    RETURN jid;
END
$$;
