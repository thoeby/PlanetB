-- 0144_thethreewaysapiececanend.sql — the transitions that know an outcome
-- write one down (db/0143).
--
-- submit_atom when a structural rule refuses a finished run, fail_atom when
-- the tab itself says the attempt failed, and expire_claims when the world
-- takes a quiet claim back. Each is db/0094, db/0093 and db/0090's own
-- function with the note added and nothing else changed. The third attempt is
-- `gave_up` rather than the other two, because that is the one somebody has to
-- do something about.
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
        -- The rule that refused a finished run, where somebody can read it
        -- (db/0143). It was only ever in verification.metrics.
        PERFORM note_tile_event(a, CASE WHEN a.attempts + 1 >= 3
                                        THEN 'gave_up' ELSE 'refused' END,
            'the ' || broke || ' rule refused it');
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

CREATE OR REPLACE FUNCTION fail_atom(p_atom bigint, p_reason text DEFAULT '') RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    a atom%rowtype;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    SELECT * INTO a FROM atom WHERE id = p_atom FOR UPDATE;
    IF a.id IS NULL OR a.state <> 'claimed' THEN
        RETURN coalesce(a.state, 'missing');
    END IF;
    IF current_user_role() <> 'admin'
       AND NOT EXISTS (SELECT 1 FROM worker w
                       WHERE w.id = a.worker_id AND w.user_id = current_user_id()) THEN
        RAISE EXCEPTION 'that piece is not in your hands' USING errcode = '42501';
    END IF;
    UPDATE atom
    SET attempts = a.attempts + 1,
        state = CASE WHEN a.attempts + 1 >= 3 THEN 'failed' ELSE 'ready' END,
        worker_id = null, claimed_at = null, heartbeat_at = null,
        result = jsonb_build_object('error', left(coalesce(p_reason, ''), 600),
                                    'attempt', a.attempts + 1)
    WHERE id = p_atom RETURNING * INTO a;
    -- What the tab said, kept past the next attempt (db/0143): `result` is
    -- overwritten by it, and the panel's line scrolls away.
    PERFORM note_tile_event(a, CASE WHEN a.state = 'failed'
                                    THEN 'gave_up' ELSE 'failed' END, p_reason);
    RETURN a.state;
END
$$;

-- db/0090's expire_claims, with the hand-back written down. One statement:
-- the events are a data-modifying CTE over the same rows the UPDATE returned,
-- because a CTE is not visible to the statement after it.
CREATE OR REPLACE FUNCTION expire_claims() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    n int := 0;
BEGIN
    WITH dead AS (
        SELECT id FROM atom
        WHERE state = 'claimed'
          AND coalesce(heartbeat_at, claimed_at) < now() - claim_patience(op)
        FOR UPDATE SKIP LOCKED
    ), reset AS (
        UPDATE atom a
        SET attempts = a.attempts + 1,
            handed_back = a.handed_back + 1,
            state = CASE WHEN a.attempts + 1 >= 3 THEN 'failed' ELSE 'ready' END,
            worker_id = null, claimed_at = null, heartbeat_at = null
        FROM dead WHERE a.id = dead.id
        RETURNING a.id, a.job_id, a.op, a.state
    ), noted AS (
        INSERT INTO tile_event (z, x, y, job_id, atom_id, op, kind, detail)
        SELECT j.z, j.x, j.y, j.id, r.id, r.op,
            CASE WHEN r.state = 'failed' THEN 'gave_up' ELSE 'handed_back' END,
            'the claim went quiet and the world took the piece back'
        FROM reset AS r INNER JOIN job AS j ON j.id = r.job_id
        RETURNING 1
    )
    SELECT count(*) INTO n FROM reset;
    RETURN n;
END
$$;
