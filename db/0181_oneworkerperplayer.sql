-- 0181_oneworkerperplayer.sql — a player is one worker, however many tabs
-- they open, and a tab may only put down a piece it is holding.
--
-- What was seen, with two tabs open: "atom 971 is not claimed by you: another
-- tab holds it since 18:28:15" in the tab that was training it, and the same
-- atom training four times over inside one tab, at four different steps.
--
-- `worker` had no unique key on user_id, and my_worker looked the row up
-- with a bare SELECT INTO: two tabs' first claims raced, both inserted, and
-- from then on every lookup — claim, heartbeat, submit, can_write — took
-- whichever row came first, on its own. So a heartbeat from the tab that
-- held the piece was refused as somebody else's; the lane gave up, and
-- fail_atom — which asked only whether the piece was *this player's*, not
-- this tab's — put it back to ready; the next lane claimed it again while the
-- first run went on unheard, and the log read as one atom at four steps.
-- Meanwhile the other tab's heartbeat was refused in turn, "it is ready — the
-- world took it back", and the two tabs took turns failing each other's work.
--
-- Three things, all one rule:
--   * one worker row per user: the duplicates are folded into the oldest row
--     (its claims, its statistics and its verifications come with it) and a
--     unique index keeps it so; my_worker upserts on it, so two tabs asking
--     at once get the same row.
--   * fail_atom and hand_back_atom put down a piece only for the worker
--     holding it. With one worker per user that is the same tab-set as
--     before; what it stops is a tab putting down what it does not hold.
--   * heartbeat's "another tab" is now true when it is said.
-- Invariant 6 holds: still row-level, still the world's decision.

-- ------------------------------------------------ fold the duplicates away
DO $$
DECLARE
    d record;
BEGIN
    FOR d IN SELECT w.id AS dup, k.keep FROM worker w
             INNER JOIN (SELECT user_id, min(id::text)::uuid AS keep FROM worker
                         GROUP BY user_id HAVING count(*) > 1) k
                 ON k.user_id = w.user_id AND k.keep <> w.id LOOP
        UPDATE atom SET worker_id = d.keep WHERE worker_id = d.dup;
        INSERT INTO worker_op_stats (worker_id, op, ok, bad)
        SELECT d.keep, op, ok, bad FROM worker_op_stats WHERE worker_id = d.dup
        ON CONFLICT (worker_id, op) DO UPDATE
        SET ok = worker_op_stats.ok + excluded.ok, bad = worker_op_stats.bad + excluded.bad;
        DELETE FROM worker_op_stats WHERE worker_id = d.dup;
        -- A perceptual check is one per worker per atom; a duplicate's copy
        -- that the kept row already has is dropped, the rest move.
        DELETE FROM verification v WHERE v.verifier_worker_id = d.dup
          AND v.kind = 'perceptual'
          AND EXISTS (SELECT 1 FROM verification k WHERE k.atom_id = v.atom_id
                      AND k.verifier_worker_id = d.keep AND k.kind = 'perceptual');
        UPDATE verification SET verifier_worker_id = d.keep WHERE verifier_worker_id = d.dup;
        UPDATE worker SET trust = least(trust, (SELECT trust FROM worker WHERE id = d.dup)),
                          last_seen = greatest(last_seen,
                                               (SELECT last_seen FROM worker WHERE id = d.dup))
        WHERE id = d.keep;
        DELETE FROM worker WHERE id = d.dup;
    END LOOP;
END
$$;

CREATE UNIQUE INDEX worker_one_per_user_idx ON worker (user_id);

-- db/0005's my_worker, as an upsert on that key.
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

-- ------------------------------------------ putting down what you are holding

-- db/0144's fail_atom: the worker holding the piece, or an admin.
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
    IF current_user_role() <> 'admin' AND a.worker_id <> my_worker(NULL) THEN
        RAISE EXCEPTION 'that piece is not in your hands' USING errcode = '42501';
    END IF;
    UPDATE atom
    SET attempts = a.attempts + 1,
        state = CASE WHEN a.attempts + 1 >= 3 THEN 'failed' ELSE 'ready' END,
        worker_id = null, claimed_at = null, heartbeat_at = null,
        result = jsonb_build_object('error', left(coalesce(p_reason, ''), 600),
                                    'attempt', a.attempts + 1)
    WHERE id = p_atom RETURNING * INTO a;
    PERFORM note_tile_event(a, CASE WHEN a.state = 'failed'
                                    THEN 'gave_up' ELSE 'failed' END, p_reason);
    RETURN a.state;
END
$$;

-- db/0079's hand_back_atom, the same way.
CREATE OR REPLACE FUNCTION hand_back_atom(p_atom bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    a atom%rowtype;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    SELECT * INTO a FROM atom WHERE id = p_atom FOR UPDATE;
    IF a.id IS NULL OR a.state <> 'claimed' THEN
        RETURN false;
    END IF;
    IF current_user_role() <> 'admin' AND a.worker_id <> my_worker(NULL) THEN
        RAISE EXCEPTION 'that piece is not in your hands' USING errcode = '42501';
    END IF;
    UPDATE atom SET state = 'ready', worker_id = null, claimed_at = null,
                    heartbeat_at = null, handed_back = handed_back + 1
    WHERE id = p_atom;
    RETURN true;
END
$$;
