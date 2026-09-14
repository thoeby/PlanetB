-- 0090_apatientclaimforalongjob.sql — how long a claim is left alone before the
-- work is taken back off it.
--
-- `expire_claims` gives every atom five minutes without a heartbeat and then
-- hands it to somebody else, counting an attempt against it. Three of those and
-- the atom is 'failed' for good and its tile is stuck until a person presses
-- Try again. That is right for a sample, which is seconds of arithmetic. It is
-- wrong for a train: a z18 tile is 7000 iterations over two million splats, its
-- frames are a hundred megabytes to fetch and its ply as much again to hash and
-- upload, and a tab nobody is looking at has its timers throttled by the
-- browser — so the beat that should have arrived inside five minutes does not.
--
-- The tab carries on training, finishes, and finds the work is no longer its
-- own. That is a whole z18 train thrown away, and the pool says "handed back
-- once by a tab that went away" about a tab that never went anywhere.
--
-- client/js/work.js now beats at every step that can run silent — after the
-- inputs are fetched, around the hash, around the upload, before the submit —
-- which closes the windows it can see. This is the other half: an atom that is
-- expected to be long is left alone for longer. The backstop still works, it
-- just matches what it is waiting for.
CREATE FUNCTION claim_patience(p_op text) RETURNS interval
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE WHEN p_op = 'train' THEN interval '30 minutes'
            ELSE interval '5 minutes' END;
$$;

REVOKE ALL ON FUNCTION claim_patience(text) FROM PUBLIC;

-- db/0079_worktakenandgivenback.sql's expire_claims, waiting as long as the
-- work it is waiting on deserves.
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
        RETURNING 1
    )
    SELECT count(*) INTO n FROM reset;
    RETURN n;
END
$$;
