-- 0006_publish.sql — money and the compare-and-swap that publishes a tile.
-- Invariant 5: every function here is one transaction, idempotent by `ref`,
-- and only ever appends to the ledger.

INSERT INTO account (id, owner_id) VALUES
('00000000-0000-0000-0000-0000000e5c20', null),   -- escrow
('00000000-0000-0000-0000-00000047a250', null);   -- treasury

CREATE FUNCTION escrow_account() RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$SELECT '00000000-0000-0000-0000-0000000e5c20'::uuid$$;
CREATE FUNCTION treasury_account() RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$SELECT '00000000-0000-0000-0000-00000047a250'::uuid$$;

CREATE FUNCTION my_account() RETURNS uuid
LANGUAGE sql STABLE AS $$
SELECT id FROM account WHERE owner_id = current_user_id();
$$;

CREATE FUNCTION account_balance(a uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$
SELECT coalesce((SELECT sum(amount) FROM ledger WHERE credit = a), 0)
     - coalesce((SELECT sum(amount) FROM ledger WHERE debit = a), 0);
$$;

-- One transfer, one ledger row, one ref. A repeated ref is a unique violation,
-- which is exactly the idempotency we want: the money moves at most once.
CREATE FUNCTION transfer(p_from uuid, p_to uuid, p_amount numeric, p_ref text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'amount must be positive';
    END IF;
    -- The treasury is where money is minted; everyone else must have it.
    IF p_from <> treasury_account() AND account_balance(p_from) < p_amount THEN
        RAISE EXCEPTION 'insufficient funds in %', p_from;
    END IF;
    INSERT INTO ledger (debit, credit, amount, ref)
    VALUES (p_from, p_to, p_amount, p_ref);
END
$$;

CREATE FUNCTION pay(to_account uuid, amount numeric, ref text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    src uuid := my_account();
BEGIN
    IF src IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    PERFORM transfer(src, to_account, amount, ref);
END
$$;

CREATE FUNCTION set_bounty(job_id bigint, amount numeric) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    src uuid := my_account();
BEGIN
    IF src IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM job j WHERE j.id = set_bounty.job_id
                   AND j.state = 'open') THEN
        RAISE EXCEPTION 'job % is not open', job_id;
    END IF;
    PERFORM transfer(src, escrow_account(), amount,
                     'bounty:' || job_id || ':' || src);
    UPDATE job SET bounty = bounty + amount WHERE id = set_bounty.job_id;
END
$$;

CREATE FUNCTION register_artifact(sha256 text, kind text, bytes bigint,
                                  algo_version text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
    p_sha  text := register_artifact.sha256;
    p_kind text := register_artifact.kind;
    p_len  bigint := register_artifact.bytes;
    p_algo text := register_artifact.algo_version;
BEGIN
    -- Invariant 1: an artifact is written once and never replaced.
    INSERT INTO artifact (sha256, kind, bytes, algo_version, created_by)
    VALUES (p_sha, p_kind, p_len, p_algo, current_user_id())
    ON CONFLICT (sha256) DO NOTHING;
    RETURN p_sha;
END
$$;

-- ------------------------------------------------------------------ escrow

-- Pays out a finished job's bounty in proportion to reported GPU time, one
-- ledger row per worker, ref pay:{job}:{worker}. Workers who reported nothing
-- share equally, so a job whose atoms carry no timing still settles.
CREATE FUNCTION release_escrow(p_job bigint) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    pot   numeric;
    total numeric;
    n     int;
    w     record;
    paid  numeric := 0;
    share numeric;
BEGIN
    SELECT bounty INTO pot FROM job WHERE id = p_job;
    IF coalesce(pot, 0) <= 0 THEN
        RETURN;
    END IF;

    CREATE TEMP TABLE shares ON COMMIT DROP AS
    SELECT a.worker_id,
           sum(coalesce((a.result ->> 'gpu_seconds')::numeric, 0)) AS secs
    FROM atom a
    WHERE a.job_id = p_job AND a.worker_id IS NOT NULL
      AND a.state IN ('verified', 'submitted')
    GROUP BY a.worker_id;

    SELECT sum(secs), count(*) INTO total, n FROM shares;
    IF n IS NULL OR n = 0 THEN
        RETURN;
    END IF;

    FOR w IN SELECT * FROM shares ORDER BY worker_id LOOP
        share := CASE WHEN total > 0 THEN round(pot * w.secs / total, 6)
                      ELSE round(pot / n, 6) END;
        paid := paid + share;
        IF share > 0 THEN
            PERFORM transfer(escrow_account(),
                (SELECT ac.id FROM account ac
                 JOIN worker wk ON wk.user_id = ac.owner_id
                 WHERE wk.id = w.worker_id),
                share, 'pay:' || p_job || ':' || w.worker_id);
        END IF;
    END LOOP;

    -- Rounding dust never stays in escrow.
    IF pot - paid > 0 THEN
        PERFORM transfer(escrow_account(), treasury_account(), pot - paid,
                         'dust:' || p_job);
    END IF;
    UPDATE job SET bounty = 0 WHERE id = p_job;
END
$$;

CREATE FUNCTION dirty_parent(p_z int, p_x int, p_y int) RETURNS void
LANGUAGE sql AS $$
INSERT INTO tile (z, x, y, dirty, expected_version)
VALUES (p_z - 2, p_x / 4, p_y / 4, true, 1)
ON CONFLICT (z, x, y) DO UPDATE
SET dirty = true, expected_version = tile.expected_version + 1;
$$;

-- ------------------------------------------------------------------ publish

-- Invariant 3. The WHERE clause is the whole safety property: a worker holding
-- a stale target_version can never win, however long it took to compute.
CREATE FUNCTION publish_tile(z int, x int, y int, target_version bigint,
                             sog_sha256 text, manifest jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid uuid := my_worker(NULL);
    jid bigint;
BEGIN
    SELECT j.id INTO jid
    FROM job j
    JOIN atom a ON a.job_id = j.id AND a.op = 'sog' AND a.state = 'verified'
    WHERE j.z = publish_tile.z AND j.x = publish_tile.x AND j.y = publish_tile.y
      AND j.target_version = publish_tile.target_version
      AND a.worker_id = wid
      AND a.output_sha256 = publish_tile.sog_sha256;
    IF jid IS NULL THEN
        RAISE EXCEPTION
            'no verified sog of yours for %/%/% at version %', z, x, y, target_version;
    END IF;

    UPDATE tile t
    SET published_version = publish_tile.target_version,
        sog_sha256 = publish_tile.sog_sha256,
        manifest = publish_tile.manifest,
        published_at = now(),
        published_by = current_user_id(),
        dirty = t.expected_version > publish_tile.target_version
    WHERE t.z = publish_tile.z AND t.x = publish_tile.x AND t.y = publish_tile.y
      AND t.expected_version = publish_tile.target_version
      AND t.published_version < publish_tile.target_version;

    IF NOT found THEN
        RETURN false;
    END IF;

    UPDATE job SET state = 'done' WHERE id = jid;
    PERFORM release_escrow(jid);

    -- The parent now has a new child and must be recompiled.
    IF z > 6 THEN
        PERFORM dirty_parent(publish_tile.z, publish_tile.x, publish_tile.y);
    END IF;
    RETURN true;
END
$$;

-- ensure_job's bounty path now actually escrows the money, so "or attach a
-- bounty" is a payment, not a claim.
CREATE OR REPLACE FUNCTION ensure_job(z int, x int, y int,
                                      bounty numeric DEFAULT 0)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    t   tile%rowtype;
    jid bigint;
BEGIN
    SELECT * INTO t FROM tile
    WHERE tile.z = ensure_job.z AND tile.x = ensure_job.x AND tile.y = ensure_job.y;
    IF t.z IS NULL THEN
        RAISE EXCEPTION 'no such tile %/%/%', z, x, y;
    END IF;
    IF t.expected_version = 0 THEN
        RAISE EXCEPTION 'tile %/%/% has no world input yet', z, x, y;
    END IF;

    IF bounty <= 0
       AND current_user_role() <> 'admin'
       AND NOT EXISTS (
           SELECT 1 FROM area
           WHERE st_intersects(area.geom, tile_bbox(z, x, y))
             AND is_area_writer(area.id)) THEN
        RAISE EXCEPTION 'not authorised for %/%/% and no bounty attached', z, x, y;
    END IF;

    SELECT id INTO jid FROM job
    WHERE job.z = ensure_job.z AND job.x = ensure_job.x AND job.y = ensure_job.y
      AND job.target_version = t.expected_version;

    IF jid IS NULL THEN
        UPDATE job SET state = 'cancelled'
        WHERE job.z = ensure_job.z AND job.x = ensure_job.x
          AND job.y = ensure_job.y AND job.state = 'open'
          AND job.target_version < t.expected_version;

        INSERT INTO job (z, x, y, target_version)
        VALUES (z, x, y, t.expected_version) RETURNING id INTO jid;
        PERFORM build_dag(jid, z, x, y);
    END IF;

    IF bounty > 0 THEN
        PERFORM set_bounty(jid, bounty);
    END IF;
    RETURN jid;
END
$$;

GRANT EXECUTE ON FUNCTION pay(uuid, numeric, text), set_bounty(bigint, numeric),
    register_artifact(text, text, bigint, text),
    publish_tile(int, int, int, bigint, text, jsonb),
    my_account(), account_balance(uuid)
TO player, admin;
