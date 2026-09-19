-- 0167_oneworkerperperson.sql — a person is one worker.
--
-- db/0001 gave worker.user_id an index and no uniqueness, and db/0005's
-- my_worker was a SELECT and then an INSERT. The first page load after an
-- empty database fires claim_atom, heartbeat and submit_atom close together,
-- every one of them asks my_worker, and two that find nothing both insert.
-- From then on `SELECT id INTO wid … WHERE user_id = uid` takes whichever row
-- the planner hands back first: the claim went under one id, the heartbeat
-- under the other — "atom 11 is not claimed by you" — the lease ran out, the
-- training went back to the pool and the same tab claimed it again.
--
-- The rows that exist are folded into the oldest one first, since worker.id
-- is what atoms, verifications and op stats point at.
WITH keep AS (
    SELECT DISTINCT ON (user_id) id, user_id FROM worker
    ORDER BY user_id ASC, last_seen ASC, id ASC
), dup AS (
    SELECT w.id AS old_id, k.id AS new_id FROM worker w
    INNER JOIN keep k ON k.user_id = w.user_id AND k.id <> w.id
), a AS (
    UPDATE atom SET worker_id = dup.new_id FROM dup WHERE atom.worker_id = dup.old_id
    RETURNING 1
), v AS (
    UPDATE verification SET verifier_worker_id = dup.new_id FROM dup
    WHERE verification.verifier_worker_id = dup.old_id
    RETURNING 1
), s AS (
    -- Two stats rows for one op fold into one; the constraint is what
    -- makes the INSERT below the merge.
    INSERT INTO worker_op_stats (worker_id, op, ok, bad)
    SELECT dup.new_id, st.op, st.ok, st.bad FROM worker_op_stats st
    INNER JOIN dup ON dup.old_id = st.worker_id
    ON CONFLICT (worker_id, op) DO UPDATE
    SET ok = worker_op_stats.ok + excluded.ok, bad = worker_op_stats.bad + excluded.bad
    RETURNING 1
)
DELETE FROM worker USING dup WHERE worker.id = dup.old_id;

ALTER TABLE worker ADD CONSTRAINT worker_user_id_key UNIQUE (user_id);

-- db/0005's my_worker, as one statement: the constraint decides, not a read
-- that another request may have raced.
CREATE OR REPLACE FUNCTION my_worker(p_caps jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid uuid := current_user_id();
    wid uuid;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    INSERT INTO worker (user_id, caps)
    VALUES (uid, coalesce(p_caps, '{}'::jsonb))
    ON CONFLICT (user_id) DO UPDATE
    SET caps = coalesce(p_caps, worker.caps), last_seen = now()
    RETURNING id INTO wid;
    RETURN wid;
END
$$;
