-- 0026_review.sql — fixes from the WP0–WP2 close-out review, rebased onto WP3–WP5.
-- Each block names the function it replaces and why; signatures are unchanged.

-- ------------------------------------------------------------ instance bounds
--
-- bump_rev read new.geom, but instance.geom is a STORED generated column and
-- is NULL in a BEFORE trigger, so an instance could be placed anywhere. The
-- point is built from lon/lat for that table.

CREATE OR REPLACE FUNCTION bump_rev() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    a area%rowtype;
    g geometry;
BEGIN
    SELECT * INTO a FROM area WHERE area.id = new.area_id;
    IF tg_table_name = 'instance' THEN
        g := st_setsrid(st_makepoint(new.lon, new.lat), 4326);
    ELSE
        g := new.geom;
    END IF;
    IF NOT st_intersects(g, a.geom) THEN
        RAISE EXCEPTION 'geometry lies outside area %', new.area_id;
    END IF;
    IF tg_op = 'UPDATE' THEN
        new.rev := old.rev + 1;
    END IF;
    RETURN new;
END
$$;

-- --------------------------------------------------------------------- money
--
-- Invariant 5. transfer() locks the paying account so two concurrent payments
-- cannot both pass the balance check. pay() namespaces the caller's ref, so a
-- player cannot pre-empt a system ref (pay:{job}:{worker}, bounty:…, dust:…)
-- and block a publish; the system refs stay bare and only functions here use
-- them.

CREATE OR REPLACE FUNCTION transfer(p_from uuid, p_to uuid, p_amount numeric, p_ref text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'amount must be positive';
    END IF;
    IF p_from <> treasury_account() THEN
        PERFORM 1 FROM account WHERE id = p_from FOR UPDATE;
        IF account_balance(p_from) < p_amount THEN
            RAISE EXCEPTION 'insufficient funds in %', p_from;
        END IF;
    END IF;
    INSERT INTO ledger (debit, credit, amount, ref)
    VALUES (p_from, p_to, p_amount, p_ref);
END
$$;

-- The catalog's own refs (db/0023_money.sql: buy:{san}:{user}, xfer:{ref}:{user})
-- end in the payer's id, so nobody else can take them first; they pass as is.
CREATE OR REPLACE FUNCTION pay(to_account uuid, amount numeric, ref text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    src uuid := my_account();
    own boolean := ref ~ ('^(buy|xfer):.*:' || current_user_id() || '$');
BEGIN
    IF src IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    PERFORM transfer(src, to_account, amount,
                     CASE WHEN own THEN ref ELSE 'user:' || src || ':' || ref END);
END
$$;

-- A bounty may be topped up: each escrow row gets its own ref. ensure_job
-- escrows only when it creates the job, so a retried call is a no-op rather
-- than a second payment.
CREATE OR REPLACE FUNCTION set_bounty(job_id bigint, amount numeric) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    src uuid := my_account();
    n   int;
BEGIN
    IF src IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM job j WHERE j.id = set_bounty.job_id
                   AND j.state = 'open') THEN
        RAISE EXCEPTION 'job % is not open', job_id;
    END IF;
    SELECT count(*) INTO n FROM ledger
    WHERE ref LIKE 'bounty:' || set_bounty.job_id || ':' || src || ':%';
    PERFORM transfer(src, escrow_account(), amount,
                     'bounty:' || job_id || ':' || src || ':' || n);
    UPDATE job SET bounty = bounty + amount WHERE id = set_bounty.job_id;
END
$$;

-- A cancelled job's bounty goes back to whoever escrowed it, one refund per
-- escrow row, keyed by that row's id so a repeat is a unique violation.
CREATE FUNCTION refund_bounty(p_job bigint) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    l record;
BEGIN
    FOR l IN SELECT id, debit, amount FROM ledger
             WHERE credit = escrow_account()
               AND ref LIKE 'bounty:' || p_job || ':%'
             ORDER BY id LOOP
        PERFORM transfer(escrow_account(), l.debit, l.amount, 'refund:' || l.id);
    END LOOP;
    UPDATE job SET bounty = 0 WHERE id = p_job;
END
$$;

-- No temp table: two payouts in one transaction used to collide on its name.
CREATE OR REPLACE FUNCTION release_escrow(p_job bigint) RETURNS void
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

    SELECT sum(s.secs), count(*) INTO total, n FROM (
        SELECT sum(coalesce((a.result ->> 'gpu_seconds')::numeric, 0)) AS secs
        FROM atom a
        WHERE a.job_id = p_job AND a.worker_id IS NOT NULL
          AND a.state IN ('verified', 'submitted')
        GROUP BY a.worker_id) AS s;
    IF n IS NULL OR n = 0 THEN
        RETURN;
    END IF;

    FOR w IN SELECT a.worker_id,
                    sum(coalesce((a.result ->> 'gpu_seconds')::numeric, 0)) AS secs
             FROM atom a
             WHERE a.job_id = p_job AND a.worker_id IS NOT NULL
               AND a.state IN ('verified', 'submitted')
             GROUP BY a.worker_id ORDER BY a.worker_id LOOP
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

    IF pot - paid > 0 THEN
        PERFORM transfer(escrow_account(), treasury_account(), pot - paid,
                         'dust:' || p_job);
    END IF;
    UPDATE job SET bounty = 0 WHERE id = p_job;
END
$$;

-- ---------------------------------------------------------------- ensure_job

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
    IF jid IS NOT NULL THEN
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
    IF bounty > 0 THEN
        PERFORM set_bounty(jid, bounty);
    END IF;
    RETURN jid;
END
$$;

-- ------------------------------------------------------------ disagreements
--
-- Invariant 7. Neither answer is trusted, so everyone behind either is marked:
-- the worker submitting now and every worker whose structural pass vouched for
-- the answer that stood (recheck_atom clears worker_id, so the row alone no
-- longer names them).

CREATE OR REPLACE FUNCTION disagreed(a atom, wid uuid, p_output text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO verification (atom_id, verifier_worker_id, kind, passed, metrics)
    VALUES (a.id, wid, 'hash', false,
            jsonb_build_object('expected', a.output_sha256, 'got', p_output));
    CREATE TEMP TABLE blamed ON COMMIT DROP AS
    SELECT DISTINCT w FROM (
        SELECT wid AS w
        UNION SELECT a.worker_id
        UNION SELECT v.verifier_worker_id FROM verification v
              WHERE v.atom_id = a.id AND v.kind = 'structural' AND v.passed) AS u
    WHERE w IS NOT NULL;
    INSERT INTO worker_op_stats (worker_id, op, bad)
    SELECT w, a.op, 1 FROM blamed
    ON CONFLICT (worker_id, op) DO UPDATE SET bad = worker_op_stats.bad + 1;
    -- db/0019_trust.sql: a disputed answer costs standing as well.
    PERFORM credit(w, -trust_loss()) FROM blamed;
    DROP TABLE blamed;
    UPDATE atom SET attempts = attempts + 1,
        state = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'ready' END,
        output_sha256 = NULL, result = NULL,
        worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
    WHERE id = a.id;
    UPDATE job SET state = 'open' WHERE id = a.job_id AND state <> 'cancelled';
END
$$;

-- A re-check is for deterministic tiles only: a trained tile's sog is judged
-- perceptually (Invariant 8) and its verify atoms are already spent.
CREATE OR REPLACE FUNCTION recheck_atom(p_atom bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a atom%rowtype;
    tz int;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    SELECT * INTO a FROM atom WHERE id = p_atom FOR UPDATE;
    IF a.id IS NULL OR a.state <> 'verified' OR NOT deterministic(a.op) THEN
        RETURN false;
    END IF;
    SELECT j.z INTO tz FROM job j WHERE j.id = a.job_id;
    IF tz >= 16 THEN
        RETURN false;
    END IF;
    UPDATE atom SET state = 'ready', worker_id = NULL,
                    claimed_at = NULL, heartbeat_at = NULL
    WHERE id = a.id;
    UPDATE job SET state = 'open' WHERE id = a.job_id AND state = 'done';
    RETURN true;
END
$$;

-- A job reopened for a re-check is done again once nothing in it is pending
-- and its tile is already published at that version; publish_tile's CAS will
-- not run twice, so this is where it closes.
CREATE OR REPLACE FUNCTION advance_atoms(a_job bigint) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE atom a SET state = 'ready'
    WHERE a.job_id = a_job AND a.state = 'waiting'
      AND NOT EXISTS (
          SELECT 1 FROM atom dep
          WHERE dep.id = ANY (a.deps)
            AND dep.state <> 'verified'
            AND NOT (a.op = 'verify' AND dep.state = 'submitted'));
    UPDATE job j SET state = 'done'
    WHERE j.id = a_job AND j.state = 'open'
      AND EXISTS (SELECT 1 FROM tile t
                  WHERE t.z = j.z AND t.x = j.x AND t.y = j.y
                    AND t.published_version = j.target_version)
      AND NOT EXISTS (SELECT 1 FROM atom a WHERE a.job_id = j.id
                      AND a.state IN ('waiting', 'ready', 'claimed', 'submitted'));
END
$$;

-- ------------------------------------------------------------------- grants
--
-- Invariant 6. Internal SECURITY DEFINER functions were executable by every
-- role through the default PUBLIC grant; only the api schema is exposed, but
-- the schema is one config line away. Client-facing functions keep their
-- explicit grants from earlier migrations.

REVOKE ALL ON FUNCTION transfer(uuid, uuid, numeric, text), release_escrow(bigint),
    refund_bounty(bigint), expire_claims(), my_worker(jsonb), dirty_parent(int, int, int),
    advance_atoms(bigint), disagreed(atom, uuid, text), new_atom(bigint, text, text, jsonb,
    jsonb, int, bigint[]), build_dag(bigint, int, int, int),
    escrow_account(), treasury_account()
FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
