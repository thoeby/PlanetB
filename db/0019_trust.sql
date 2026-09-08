-- 0019_trust.sql — WP3.4: what the world thinks of a worker, as one number.
--
-- ARCHITECTURE §8 calls it a scalar per worker in v1, with per-op counts kept
-- for something better later. It moves for one reason only: a verification of
-- that worker's own output. A perceptual pass is worth +0.05 to the trainer, a
-- rejection −0.2, and a deterministic disagreement the same −0.2 to both
-- workers, because one of them is wrong and there is no telling which.
--
-- An accepted atom is worth a little as well. Without it nothing could ever be
-- verified: a new worker starts at 0.5, checking somebody's tile needs 0.6, and
-- the only other way up is to have your own tile checked — which needs somebody
-- above 0.6 to do it. The small credit for work that passes its structural
-- checks is what breaks that circle, and it is deliberately much smaller than
-- the signal from a real verification.

CREATE FUNCTION trust_gain() RETURNS numeric LANGUAGE sql IMMUTABLE AS $$SELECT 0.05$$;
CREATE FUNCTION trust_loss() RETURNS numeric LANGUAGE sql IMMUTABLE AS $$SELECT 0.2$$;
CREATE FUNCTION trust_work() RETURNS numeric LANGUAGE sql IMMUTABLE AS $$SELECT 0.01$$;

-- How much a worker must be trusted to be given an op at all.
CREATE FUNCTION trust_min(p_op text) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE p_op WHEN 'train' THEN 0.3 WHEN 'verify' THEN 0.6 ELSE 0 END::numeric;
$$;

CREATE FUNCTION credit(p_worker uuid, p_delta numeric) RETURNS void
LANGUAGE sql AS $$
UPDATE worker SET trust = least(1.0, greatest(0.0, trust + p_delta))
WHERE id = p_worker AND p_delta <> 0;
$$;

CREATE FUNCTION record_ok(p_worker uuid, p_op text) RETURNS void
LANGUAGE sql AS $$
INSERT INTO worker_op_stats (worker_id, op, ok) VALUES (p_worker, p_op, 1)
ON CONFLICT (worker_id, op) DO UPDATE SET ok = worker_op_stats.ok + 1;
$$;

-- ------------------------------------------------------------------ claim

CREATE OR REPLACE FUNCTION claim_atom(p_caps jsonb DEFAULT '{}'::jsonb) RETURNS atom
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid   uuid;
    trust numeric;
    a     atom%rowtype;
BEGIN
    PERFORM expire_claims();
    wid := my_worker(p_caps);
    SELECT w.trust INTO trust FROM worker w WHERE w.id = wid;

    SELECT a2.* INTO a
    FROM atom a2
    JOIN job j ON j.id = a2.job_id AND j.state = 'open'
    WHERE a2.state = 'ready'
      AND (NOT coalesce((a2.params ->> 'needs_webgpu')::boolean, false)
           OR coalesce((p_caps ->> 'webgpu')::boolean, false))
      AND coalesce((a2.params ->> 'min_vram_gb')::numeric, 0)
          <= coalesce((p_caps ->> 'vram_gb')::numeric, 0)
      AND coalesce(trust, 0) >= trust_min(a2.op)
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

-- --------------------------------------------------------------- the counts

-- db/0015_structural.sql's, with both sides of a disagreement paying for it.
CREATE OR REPLACE FUNCTION disagreed(a atom, wid uuid, p_output text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO verification (atom_id, verifier_worker_id, kind, passed, metrics)
    VALUES (a.id, wid, 'hash', false,
            jsonb_build_object('expected', a.output_sha256, 'got', p_output));
    INSERT INTO worker_op_stats (worker_id, op, bad)
    SELECT DISTINCT w, a.op, 1 FROM unnest(ARRAY[wid, a.worker_id]) AS u (w)
    WHERE w IS NOT NULL
    ON CONFLICT (worker_id, op) DO UPDATE SET bad = worker_op_stats.bad + 1;
    PERFORM credit(w, -trust_loss())
    FROM (SELECT DISTINCT unnest(ARRAY[wid, a.worker_id]) AS w) u WHERE w IS NOT NULL;
    UPDATE atom SET attempts = attempts + 1,
        state = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'ready' END,
        output_sha256 = NULL, result = NULL,
        worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
    WHERE id = a.id;
    UPDATE job SET state = 'open' WHERE id = a.job_id AND state <> 'cancelled';
END
$$;

-- db/0018_spot.sql's, with the trainer's standing following the verdict.
CREATE OR REPLACE FUNCTION rejected(a atom, trainer uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    published boolean;
BEGIN
    IF trainer IS NOT NULL THEN
        INSERT INTO worker_op_stats (worker_id, op, bad) VALUES (trainer, 'train', 1)
        ON CONFLICT (worker_id, op) DO UPDATE SET bad = worker_op_stats.bad + 1;
        PERFORM credit(trainer, -trust_loss());
    END IF;
    UPDATE tile t SET suspect = true
    FROM job j
    WHERE j.id = a.job_id AND t.z = j.z AND t.x = j.x AND t.y = j.y
      AND t.sog_sha256 = a.output_sha256
    RETURNING true INTO published;
    IF coalesce(published, false) THEN
        RETURN 'suspect';
    END IF;
    RETURN retrain(a);
END
$$;

-- db/0017_verify.sql's, with the trainer paid for a pass and the verifier's own
-- work counted.
CREATE OR REPLACE FUNCTION submit_verification(p_atom bigint, p_passed boolean,
                                               p_metrics jsonb DEFAULT '{}'::jsonb,
                                               p_spot boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a       atom%rowtype;
    wid     uuid := my_worker(NULL);
    trainer uuid;
BEGIN
    SELECT * INTO a FROM atom WHERE id = p_atom FOR UPDATE;
    IF a.id IS NULL OR a.op <> 'sog' THEN
        RAISE EXCEPTION 'atom % is not a sog to verify', p_atom;
    END IF;
    IF a.state NOT IN ('submitted', 'verified') THEN
        RAISE EXCEPTION 'sog % is %, and has no answer to check', p_atom, a.state;
    END IF;
    SELECT dep.worker_id INTO trainer FROM atom dep
    WHERE dep.id = ANY (a.deps) AND dep.op = 'train';
    IF wid IN (a.worker_id, trainer) THEN
        RAISE EXCEPTION 'you produced sog % and may not verify it', p_atom;
    END IF;

    INSERT INTO verification (atom_id, verifier_worker_id, kind, passed, metrics)
    VALUES (a.id, wid, 'perceptual', p_passed,
            coalesce(p_metrics, '{}'::jsonb)
            || jsonb_build_object('spot', p_spot, 'output', a.output_sha256))
    ON CONFLICT (atom_id, verifier_worker_id) WHERE kind = 'perceptual'
        AND verifier_worker_id IS NOT NULL
    DO UPDATE SET passed = excluded.passed, metrics = excluded.metrics, at = now();
    PERFORM record_ok(wid, 'verify');

    IF NOT p_passed THEN
        RETURN rejected(a, trainer);
    END IF;
    PERFORM credit(trainer, trust_gain());
    PERFORM record_ok(trainer, 'train');
    IF a.state = 'submitted' AND verify_passes(a) >= verify_required(a) THEN
        UPDATE atom SET state = 'verified' WHERE id = a.id;
        SELECT * INTO a FROM atom WHERE id = a.id;
        PERFORM advance_atoms(a.job_id);
        PERFORM publish_sog(a, (SELECT user_id FROM worker WHERE id = a.worker_id),
                            a.result -> 'manifest');
        RETURN 'verified';
    END IF;
    RETURN a.state;
END
$$;

-- A trainer the world already trusts is checked once rather than three times.
-- The train atom usually has no worker when the DAG is built; it has one when
-- an earlier job's atom is reused, which is exactly when this is worth asking.
CREATE OR REPLACE FUNCTION verify_count(p_train bigint) RETURNS int
LANGUAGE sql STABLE AS $$
SELECT CASE
    WHEN (SELECT w.trust FROM atom a JOIN worker w ON w.id = a.worker_id
          WHERE a.id = p_train) >= 0.95 THEN 1
    ELSE greatest(coalesce(current_setting('app.verify_min', true)::int, 3), 1)
END;
$$;

-- db/0017_verifydag.sql's, with the two counts kept: a worker whose atom is
-- accepted gains a little standing, and two workers who agree about a
-- deterministic answer gain the same as a perceptual pass is worth.
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
        INSERT INTO worker_op_stats (worker_id, op, bad) VALUES (wid, a.op, 1)
        ON CONFLICT (worker_id, op) DO UPDATE SET bad = worker_op_stats.bad + 1;
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
        PERFORM credit(a.worker_id, trust_gain());
        PERFORM credit(wid, trust_gain());
    END IF;

    INSERT INTO verification (atom_id, verifier_worker_id, kind, passed)
    VALUES (a.id, wid, 'structural', true);
    PERFORM record_ok(wid, a.op);
    PERFORM credit(wid, trust_work());

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
