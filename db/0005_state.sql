-- 0005_state.sql — WP0.6 continued: the atom state machine.
-- waiting -> ready -> claimed -> submitted/verified, with expiry back to ready.
-- Nothing on the server drives this; every transition is a client call.

CREATE FUNCTION atom_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    allowed text [];
BEGIN
    IF new.state = old.state THEN
        RETURN new;
    END IF;
    allowed := CASE old.state
        WHEN 'waiting' THEN ARRAY['ready', 'failed']
        WHEN 'ready' THEN ARRAY['claimed', 'failed', 'waiting']
        WHEN 'claimed' THEN ARRAY['ready', 'submitted', 'verified', 'failed']
        WHEN 'submitted' THEN ARRAY['verified', 'failed', 'ready']
        WHEN 'verified' THEN ARRAY['failed']
        WHEN 'failed' THEN ARRAY['ready', 'waiting']
    END;
    IF NOT (new.state = ANY (allowed)) THEN
        RAISE EXCEPTION 'illegal atom transition % -> %', old.state, new.state;
    END IF;
    IF new.state = 'claimed' AND (new.worker_id IS NULL OR new.claimed_at IS NULL) THEN
        RAISE EXCEPTION 'a claimed atom needs a worker and a claim time';
    END IF;
    RETURN new;
END
$$;

CREATE TRIGGER atom_guard BEFORE UPDATE ON atom
FOR EACH ROW EXECUTE FUNCTION atom_state_guard();

-- An atom is ready once its dependencies are verified. A verify atom is the
-- exception: it exists to turn a submitted result into a verified one, so it
-- may start as soon as its target is submitted.
CREATE FUNCTION advance_atoms(a_job bigint) RETURNS void
LANGUAGE sql AS $$
UPDATE atom a SET state = 'ready'
WHERE a.job_id = a_job AND a.state = 'waiting'
  AND NOT EXISTS (
      SELECT 1 FROM atom dep
      WHERE dep.id = ANY (a.deps)
        AND dep.state <> 'verified'
        AND NOT (a.op = 'verify' AND dep.state = 'submitted'));
$$;

-- ------------------------------------------------------------------ workers

CREATE FUNCTION my_worker(p_caps jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid uuid := current_user_id();
    wid uuid;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    SELECT id INTO wid FROM worker WHERE user_id = uid;
    IF wid IS NULL THEN
        INSERT INTO worker (user_id, caps)
        VALUES (uid, coalesce(p_caps, '{}'::jsonb)) RETURNING id INTO wid;
    ELSE
        UPDATE worker SET caps = coalesce(p_caps, caps), last_seen = now()
        WHERE id = wid;
    END IF;
    RETURN wid;
END
$$;

-- ------------------------------------------------------------------ expiry

-- Called from claim_atom, never from a cron (Invariant 9): the only thing that
-- can notice a dead worker is the next live one.
CREATE FUNCTION expire_claims() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    n int := 0;
BEGIN
    WITH dead AS (
        SELECT id FROM atom
        WHERE state = 'claimed'
          AND coalesce(heartbeat_at, claimed_at) < now() - interval '5 minutes'
        FOR UPDATE SKIP LOCKED
    ), reset AS (
        UPDATE atom a
        SET attempts = a.attempts + 1,
            state = CASE WHEN a.attempts + 1 >= 3 THEN 'failed' ELSE 'ready' END,
            worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
        FROM dead WHERE a.id = dead.id
        RETURNING 1
    )
    SELECT count(*) INTO n FROM reset;
    RETURN n;
END
$$;

-- ------------------------------------------------------------------- claim

CREATE FUNCTION claim_atom(p_caps jsonb DEFAULT '{}'::jsonb) RETURNS atom
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
    ORDER BY j.bounty DESC, a2.id
    FOR UPDATE OF a2 SKIP LOCKED
    LIMIT 1;

    IF a.id IS NULL THEN
        RETURN NULL;
    END IF;

    -- The claim also reserves /jobs/{atom_id}/ for this worker; can_write
    -- (WP0.10) allows uploads there and nowhere else.
    UPDATE atom SET state = 'claimed', worker_id = wid,
                    claimed_at = now(), heartbeat_at = now()
    WHERE id = a.id RETURNING * INTO a;
    RETURN a;
END
$$;

CREATE FUNCTION heartbeat(p_atom bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid uuid := my_worker(NULL);
BEGIN
    UPDATE atom SET heartbeat_at = now()
    WHERE id = p_atom AND state = 'claimed' AND worker_id = wid;
    IF NOT found THEN
        RAISE EXCEPTION 'atom % is not claimed by you', p_atom;
    END IF;
END
$$;

-- ------------------------------------------------------------------ submit

CREATE FUNCTION run_structural(a atom, p_result jsonb, p_bytes bigint)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    r      record;
    passed boolean;
BEGIN
    FOR r IN SELECT * FROM structural_rule WHERE op = a.op ORDER BY name LOOP
        EXECUTE 'SELECT (' || r.rule || ')' INTO passed USING a, p_result, p_bytes;
        IF passed IS DISTINCT FROM true THEN
            RETURN r.name;
        END IF;
    END LOOP;
    RETURN NULL;
END
$$;

CREATE FUNCTION submit_atom(p_atom bigint, p_output text, p_result jsonb)
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

    -- Deterministic ops: a second, different answer for the same atom_hash
    -- means one of the two workers is wrong, so neither result is trusted.
    IF a.op IN ('merge', 'sog') AND a.output_sha256 IS NOT NULL THEN
        INSERT INTO verification (atom_id, verifier_worker_id, kind, passed, metrics)
        VALUES (a.id, wid, 'hash', a.output_sha256 = p_output,
                jsonb_build_object('expected', a.output_sha256, 'got', p_output));
        IF a.output_sha256 <> p_output THEN
            UPDATE atom SET state = 'failed', worker_id = NULL
            WHERE id = a.id;
            RETURN 'failed';
        END IF;
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

GRANT EXECUTE ON FUNCTION ensure_job(int, int, int, numeric),
    claim_atom(jsonb), heartbeat(bigint), submit_atom(bigint, text, jsonb)
TO player, admin;
