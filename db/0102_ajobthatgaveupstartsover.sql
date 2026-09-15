-- 0102_ajobthatgaveupstartsover.sql — a stuck job starts over, or goes away.
--
-- "Try again" (db/0050_tryagain.sql) put back only the atoms that had failed.
-- That is the wrong unit when the failure is what an earlier atom left behind:
-- a sog that refuses an empty ply fails three times, and the retry hands it the
-- same empty ply, made by an assemble that ran before the ground was there. The
-- person pressing the button means the tile, so the whole job starts over from
-- its first atom; a piece another job has since finished is adopted again by
-- new_atom's content addressing (Invariant 2), so nothing sound is redone.
--
-- And a job the tool cannot finish is not left in the list for ever: drop_job
-- cancels it the way recompile_land does (db/0084), bounty refunded, and the
-- tile is asked for again only when somebody asks for it.
CREATE OR REPLACE FUNCTION retry_job(p_job bigint) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    n int := 0;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    IF NOT may_retry_job(p_job) THEN
        RAISE EXCEPTION 'that ground is not yours to render again'
            USING errcode = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM atom WHERE job_id = p_job AND state = 'failed') THEN
        RETURN 0;
    END IF;
    UPDATE atom SET state = CASE WHEN cardinality(deps) = 0 THEN 'ready'
                                 ELSE 'waiting' END,
                    attempts = 0, output_sha256 = NULL, result = NULL,
                    worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
    WHERE job_id = p_job AND state <> 'claimed';
    GET DIAGNOSTICS n = ROW_COUNT;
    UPDATE job SET state = 'open' WHERE id = p_job AND state <> 'cancelled';
    PERFORM advance_atoms(p_job);
    RETURN n;
END
$$;

CREATE FUNCTION drop_job(p_job bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    IF NOT may_retry_job(p_job) THEN
        RAISE EXCEPTION 'that ground is not yours to drop' USING errcode = '42501';
    END IF;
    UPDATE job SET state = 'cancelled' WHERE id = p_job AND state = 'open';
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    PERFORM refund_bounty(p_job);
    RETURN true;
END
$$;
GRANT EXECUTE ON FUNCTION drop_job(bigint) TO player, admin;

CREATE FUNCTION api.drop_job(job_id bigint) RETURNS boolean
LANGUAGE sql AS $$SELECT public.drop_job(job_id)$$;
GRANT EXECUTE ON FUNCTION api.drop_job(bigint) TO player, admin;
