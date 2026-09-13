-- 0079_worktakenandgivenback.sql — a render somebody walked away from.
--
-- SPEC §3.12 and PLAYER-RUN story 13: "A render job is abandoned: it returns
-- to the pool with the sentence."
--
-- db/0005_state.sql already has the backstop: `expire_claims`, called by the
-- next worker to ask for work, takes a piece back off a tab that has not
-- beaten for five minutes. That is right for a tab that crashed or lost the
-- network, and wrong for the ordinary case — somebody closes the tab, and the
-- work sits in nobody's hands for five minutes while the pool says it is
-- "in hand". A tab that is going away can say so, and this is what it says.
--
-- Either way the piece is counted: `handed_back` is how many times this atom
-- has been taken back from somebody, which is the sentence the pool shows.
-- It is not an attempt and not a failure — nothing went wrong with the work,
-- it was simply not done — so `attempts` is left alone and the atom goes
-- straight back to 'ready'.

ALTER TABLE atom ADD COLUMN handed_back int NOT NULL DEFAULT 0;

CREATE FUNCTION hand_back_atom(p_atom bigint) RETURNS boolean
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
    -- Only the tab that holds it, or an admin: giving back somebody else's
    -- work is taking it away from them.
    IF current_user_role() <> 'admin'
       AND NOT EXISTS (SELECT 1 FROM worker w
                       WHERE w.id = a.worker_id AND w.user_id = current_user_id()) THEN
        RAISE EXCEPTION 'that piece is not in your hands' USING errcode = '42501';
    END IF;
    UPDATE atom SET state = 'ready', worker_id = null, claimed_at = null,
                    heartbeat_at = null, handed_back = handed_back + 1
    WHERE id = p_atom;
    RETURN true;
END
$$;

GRANT EXECUTE ON FUNCTION hand_back_atom(bigint) TO player, admin;

CREATE FUNCTION api.hand_back_atom(atom_id bigint) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path = public AS $$
SELECT public.hand_back_atom(atom_id);
$$;

GRANT EXECUTE ON FUNCTION api.hand_back_atom(bigint) TO player, admin;

-- db/0005_state.sql's expire_claims, counting what it takes back. A tab that
-- stopped beating is a tab that went away without saying so; the pool says the
-- same thing about both.
CREATE OR REPLACE FUNCTION expire_claims() RETURNS int
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

-- db/0070_therebuildopensitself.sql's render_pool, with the sentence.
CREATE OR REPLACE FUNCTION render_pool(p_lon double precision DEFAULT null,
                                       p_lat double precision DEFAULT null,
                                       p_limit int DEFAULT 40) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(j ORDER BY j ->> 'ordering'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object(
        'job', job.id, 'z', job.z, 'x', job.x, 'y', job.y,
        'bounty', job.bounty, 'version', job.target_version,
        'opened_at', job.created_at,
        'ready', (SELECT count(*) FROM atom a
                  WHERE a.job_id = job.id AND a.state IN ('ready', 'waiting')),
        'claimed', (SELECT count(*) FROM atom a
                    WHERE a.job_id = job.id AND a.state = 'claimed'),
        'failed', (SELECT count(*) FROM atom a
                   WHERE a.job_id = job.id AND a.state = 'failed'),
        'handed_back', (SELECT coalesce(sum(a.handed_back), 0) FROM atom a
                        WHERE a.job_id = job.id),
        'may_retry', may_retry_job(job.id),
        'made', CASE
            WHEN EXISTS (SELECT 1 FROM atom a
                         WHERE a.job_id = job.id AND a.op = 'train') THEN 'trained'
            WHEN EXISTS (SELECT 1 FROM atom a
                         WHERE a.job_id = job.id AND a.op = 'assemble') THEN 'assembled'
            ELSE 'merged from its children' END,
        'needs_webgpu', EXISTS (
            SELECT 1 FROM atom a WHERE a.job_id = job.id
              AND coalesce((a.params ->> 'needs_webgpu')::boolean, false)),
        'metres', CASE WHEN p_lon IS null THEN null ELSE
            st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                        st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography) END,
        'ordering', lpad((1000000 - least(job.bounty, 999999))::bigint::text, 9, '0')
            || lpad(coalesce(CASE WHEN p_lon IS null THEN 0 ELSE
                st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                            st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography)
                END, 0)::bigint::text, 12, '0')
            || lpad((18 - job.z)::text, 2, '0')) AS j
    FROM job
    INNER JOIN tile t ON t.z = job.z AND t.x = job.x AND t.y = job.y
    WHERE job.state = 'open'
      AND job.target_version = t.expected_version
      AND EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                  AND a.state IN ('ready', 'waiting', 'claimed', 'failed'))
      AND NOT EXISTS (SELECT 1 FROM atom a
                      WHERE a.job_id = job.id AND a.op = 'merge'
                        AND a.state IN ('ready', 'waiting')
                        AND NOT merge_has_a_child(a.inputs))
    ORDER BY job.bounty DESC, job.id
    LIMIT greatest(p_limit, 0)
) pool;
$$;
