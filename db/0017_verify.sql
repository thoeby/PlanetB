-- 0017_verify.sql — WP3.2: the perceptual half of Invariant 8.
--
-- A merged or sampled tile is accepted because its bytes hash the same twice.
-- A trained one cannot be: two GPUs do not take the same optimisation path, so
-- there is nothing to compare hashes with. Its .sog is instead rendered by
-- three other tabs from poses the trainer never fitted, and accepted if all
-- three find it close enough. This is probabilistic quality assurance and is
-- called that everywhere; it is not proof.
--
-- What a verification is tied to is the exact output it looked at: the metrics
-- carry the .sog's sha256, so an answer about one training run can never be
-- counted towards another.

-- The pointer update a verified .sog earns, without the "and it was yours"
-- check publish_tile makes: the worker that encoded it is usually long gone by
-- the time the third verifier answers. Invariant 3 is unchanged — this is the
-- same compare-and-swap, and it still takes the parent's lock first
-- (db/0010_lockorder.sql).
CREATE FUNCTION publish_sog(a atom, p_by uuid, p_manifest jsonb) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
    j job%rowtype;
BEGIN
    SELECT * INTO j FROM job WHERE id = a.job_id;
    IF j.id IS NULL OR a.output_sha256 IS NULL OR p_manifest IS NULL THEN
        RETURN false;
    END IF;
    IF j.z > 6 THEN
        PERFORM 1 FROM tile t
        WHERE t.z = j.z - 2 AND t.x = j.x / 4 AND t.y = j.y / 4 FOR UPDATE;
    END IF;

    UPDATE tile t
    SET published_version = j.target_version,
        sog_sha256 = a.output_sha256,
        manifest = p_manifest,
        published_at = now(),
        published_by = p_by,
        dirty = t.expected_version > j.target_version
    WHERE t.z = j.z AND t.x = j.x AND t.y = j.y
      AND t.expected_version = j.target_version
      AND t.published_version < j.target_version;
    IF NOT found THEN
        RETURN false;
    END IF;

    UPDATE job SET state = 'done' WHERE id = j.id;
    PERFORM release_escrow(j.id);
    IF j.z > 6 THEN
        PERFORM dirty_parent(j.z, j.x, j.y);
    END IF;
    RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION publish_tile(z int, x int, y int, target_version bigint,
                                        sog_sha256 text, manifest jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid uuid := my_worker(NULL);
    a   atom%rowtype;
BEGIN
    SELECT at.* INTO a
    FROM atom at
    JOIN job j ON j.id = at.job_id
    WHERE at.op = 'sog' AND at.state = 'verified'
      AND j.z = publish_tile.z AND j.x = publish_tile.x AND j.y = publish_tile.y
      AND j.target_version = publish_tile.target_version
      AND at.worker_id = wid
      AND at.output_sha256 = publish_tile.sog_sha256;
    IF a.id IS NULL THEN
        RAISE EXCEPTION
            'no verified sog of yours for %/%/% at version %', z, x, y, target_version;
    END IF;
    RETURN publish_sog(a, current_user_id(), publish_tile.manifest);
END
$$;

-- --------------------------------------------------------------- counting
--
-- How many independent tabs have to agree, and how many already do. The
-- requirement is the number of verify atoms the DAG built for this job, so
-- WP3.4 can lower it for a trusted trainer by building fewer of them.

CREATE FUNCTION verify_required(a atom) RETURNS int
LANGUAGE sql STABLE AS $$
SELECT greatest(count(*)::int, 1) FROM atom v
WHERE v.job_id = a.job_id AND v.op = 'verify';
$$;

CREATE FUNCTION verify_passes(a atom) RETURNS int
LANGUAGE sql STABLE AS $$
SELECT count(DISTINCT v.verifier_worker_id)::int
FROM verification v
WHERE v.atom_id = a.id AND v.kind = 'perceptual' AND v.passed
  AND v.metrics ->> 'output' IS NOT DISTINCT FROM a.output_sha256;
$$;

-- Nobody checks their own work: not the tab that encoded the .sog, and not the
-- one that trained the ply underneath it.
CREATE FUNCTION may_verify(p_job bigint, p_atom bigint, p_worker uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
SELECT p_worker IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM atom made
      WHERE made.job_id = p_job AND made.op IN ('sog', 'train')
        AND made.worker_id = p_worker)
  AND NOT EXISTS (
      SELECT 1 FROM atom sib
      WHERE sib.job_id = p_job AND sib.op = 'verify'
        AND sib.id IS DISTINCT FROM p_atom AND sib.worker_id = p_worker);
$$;

-- ------------------------------------------------------------- the answer

-- A perceptual rejection sends a whole branch of the DAG back: the .sog and the
-- checks that were made of it go to `waiting` while the trainer has another go.
-- Nothing else may make those moves — retrain() below is the only caller.
CREATE OR REPLACE FUNCTION atom_state_guard() RETURNS trigger
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
        WHEN 'submitted' THEN ARRAY['verified', 'failed', 'ready', 'waiting']
        -- verified -> ready is a recheck (db/0015_structural.sql).
        WHEN 'verified' THEN ARRAY['failed', 'ready', 'waiting']
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

-- A rejected training run goes back to the trainer, not to the encoder: the
-- .sog is a deterministic function of the ply and re-encoding it would produce
-- the same bytes and the same complaint. Three rejections and the tile gives
-- up at this version, which is what every other bad result here does
-- (db/0015_structural.sql's disagreed()).
CREATE FUNCTION retrain(a atom) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    tries int := a.attempts + 1;
BEGIN
    IF tries >= 3 THEN
        UPDATE atom SET state = 'failed', attempts = tries WHERE id = a.id;
        RETURN 'failed';
    END IF;
    UPDATE atom SET state = 'ready', output_sha256 = NULL, result = NULL,
                    worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
    WHERE id = ANY (a.deps) AND op = 'train';
    UPDATE atom SET state = 'waiting', attempts = tries, output_sha256 = NULL,
                    result = NULL, worker_id = NULL, claimed_at = NULL,
                    heartbeat_at = NULL
    WHERE id = a.id;
    UPDATE atom SET state = 'waiting'
    WHERE job_id = a.job_id AND op = 'verify' AND state <> 'claimed';
    UPDATE job SET state = 'open' WHERE id = a.job_id AND state <> 'cancelled';
    RETURN 'waiting';
END
$$;

CREATE FUNCTION submit_verification(p_atom bigint, p_passed boolean,
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

    IF NOT p_passed THEN
        RETURN rejected(a, trainer);
    END IF;
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

-- The trainer carries the blame for a picture that does not match: everything
-- downstream of it is deterministic and separately hash-checked.
CREATE FUNCTION rejected(a atom, trainer uuid) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
    IF trainer IS NOT NULL THEN
        INSERT INTO worker_op_stats (worker_id, op, bad) VALUES (trainer, 'train', 1)
        ON CONFLICT (worker_id, op) DO UPDATE SET bad = worker_op_stats.bad + 1;
    END IF;
    RETURN retrain(a);
END
$$;

GRANT EXECUTE ON FUNCTION submit_verification(bigint, boolean, jsonb, boolean)
TO player, admin;

CREATE FUNCTION api.submit_verification(atom_id bigint, passed boolean,
                                        metrics jsonb DEFAULT '{}'::jsonb,
                                        spot boolean DEFAULT false)
RETURNS text LANGUAGE sql AS $$
SELECT public.submit_verification(atom_id, passed, metrics, spot)
$$;
GRANT EXECUTE ON FUNCTION api.submit_verification(bigint, boolean, jsonb, boolean)
TO player, admin;
