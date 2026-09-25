-- 0218_thepoolsayswhyitrefuses.sql — a job the pool will not hand out says
-- why, and a tile asked for again starts over what gave up.
--
-- What was seen: "14/8548/5800: 1 piece(s) left — press Render again", and
-- pressing Render again said it again. claim_for refuses a ready piece for
-- five reasons — the land moved past the job's version, a merge with no
-- published child, WebGPU or a buffer the tab has not got, an op version
-- this page does not build (db/0178) — and answers null for all of them, the
-- same null as "nothing left". The tab counted the pieces it could see and
-- told the player to press again. And a job that was replaced under a tab
-- (a finer tile under it published, so ensure_job cancelled it and opened
-- the next) read the same way: the tile's new job had one ready piece, and
-- the tab was still asking for the old job by name.
--
-- Two things:
--   * job_refusal(job, caps) is claim_for's filter turned into a sentence.
--     Null means a claim would hand something out; anything else is the
--     reason it would not, in words the panel can show. The client asks it
--     only when the count and the claim disagree (client/js/renderpool.js).
--   * ensure_job, handed a job that gave up — a piece failed three times
--     and nothing else can move — puts the pieces back. Approving a
--     submission, publishing a child, "Compile it all again": each is
--     somebody asking for this tile, and a tile asked for is not left
--     holding a failure (retry_job, db/0102, is the same move by hand).
-- Invariant 4 holds: ensure_job still opens every job. Invariant 9 holds:
-- the world decides, computes nothing.

-- A job that cannot move on its own: nothing is being done to it, and what
-- is waiting waits on a piece that gave up (or on nothing, db/0081).
CREATE FUNCTION job_gave_up(p_job bigint) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT EXISTS (SELECT 1 FROM job j WHERE j.id = p_job AND j.state = 'open')
   AND NOT EXISTS (SELECT 1 FROM atom a WHERE a.job_id = p_job
                   AND a.state IN ('ready', 'claimed', 'submitted'))
   AND EXISTS (SELECT 1 FROM atom a WHERE a.job_id = p_job AND a.state = 'failed');
$$;

REVOKE ALL ON FUNCTION job_gave_up(bigint) FROM PUBLIC;

-- ------------------------------------------------------ why the pool refuses

-- What claim_for would say about one ready piece, if it could say anything.
CREATE FUNCTION atom_refusal(a atom, p_caps jsonb) RETURNS text
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT CASE
    WHEN a.op = 'merge' AND NOT merge_has_a_child(a.inputs)
        THEN 'it merges the finer tiles under it, and none of them is published yet'
    WHEN coalesce((a.params ->> 'needs_webgpu')::boolean, false)
         AND NOT coalesce((p_caps ->> 'webgpu')::boolean, false)
        THEN a.op || ' needs WebGPU, and this tab has not got it'
    WHEN p_caps ->> 'max_buffer_mb' IS NOT NULL
         AND (p_caps ->> 'max_buffer_mb')::numeric < atom_buffer_mb(a)
        THEN format('%s wants a %s MB buffer and this tab can hold %s MB'
                    || ' — another machine can take it',
                    a.op, atom_buffer_mb(a), p_caps ->> 'max_buffer_mb')
    WHEN p_caps -> 'algo' ->> a.op IS NOT NULL
         AND p_caps -> 'algo' ->> a.op <> a.algo_version
        THEN format('the piece is %s and this page builds %s — reload the page'
                    || ' (the world builds %s)',
                    a.algo_version, p_caps -> 'algo' ->> a.op, algo_current(a.op))
    END;
$$;

REVOKE ALL ON FUNCTION atom_refusal(atom, jsonb) FROM PUBLIC;

-- Why claim_for(p_job, p_caps) would hand out nothing, or null when it would
-- hand something out. The order is claim_for's: the job first, then the
-- version, then the pieces.
CREATE FUNCTION job_refusal(p_job bigint, p_caps jsonb DEFAULT '{}'::jsonb)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    j    job%rowtype;
    t    tile%rowtype;
    live bigint;
    n    record;
    why  text;
BEGIN
    SELECT * INTO j FROM job WHERE id = p_job;
    IF j.id IS NULL THEN
        RETURN 'there is no such job';
    END IF;
    SELECT * INTO t FROM tile WHERE z = j.z AND x = j.x AND y = j.y;
    live := live_job(j.z, j.x, j.y, t.expected_version);
    IF j.state <> 'open' OR j.target_version <> t.expected_version THEN
        RETURN CASE
            WHEN t.published_version >= t.expected_version
                THEN 'the tile is published'
            WHEN live IS NOT NULL AND live <> j.id
                THEN format('the land under it changed while it was being worked,'
                            || ' and job %s replaced this one', live)
            ELSE 'the land changed after this was opened — submit it again' END;
    END IF;
    SELECT count(*) FILTER (WHERE a.state = 'ready') AS ready,
           count(*) FILTER (WHERE a.state = 'claimed') AS claimed,
           count(*) FILTER (WHERE a.state = 'failed') AS failed,
           count(*) FILTER (WHERE a.state = 'waiting') AS waiting
    INTO n FROM atom a WHERE a.job_id = j.id;
    IF n.ready = 0 THEN
        RETURN CASE
            WHEN n.claimed > 0 THEN format('%s piece(s) are in somebody''s hands', n.claimed)
            WHEN n.failed > 0 THEN format('%s piece(s) gave up — Try again puts them back',
                                          n.failed)
            WHEN n.waiting > 0 THEN 'every piece is waiting on another job'
            ELSE 'every piece of it is done — it is the publish that is missing' END;
    END IF;
    SELECT atom_refusal(a, p_caps) INTO why
    FROM atom a WHERE a.job_id = j.id AND a.state = 'ready'
    ORDER BY atom_refusal(a, p_caps) IS NULL DESC, a.id
    LIMIT 1;
    RETURN why;
END
$$;

GRANT EXECUTE ON FUNCTION job_refusal(bigint, jsonb) TO player, admin;

CREATE FUNCTION api.job_refusal(job_id bigint, caps jsonb DEFAULT '{}'::jsonb)
RETURNS text
LANGUAGE sql STABLE AS $$SELECT public.job_refusal(job_id, caps)$$;

-- db/0216: executable by the roles it is granted to, not by everybody.
REVOKE EXECUTE ON FUNCTION api.job_refusal(bigint, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.job_refusal(bigint, jsonb) TO player, admin;

-- ------------------------------------------- a tile asked for starts over

-- Whether the job of a tile that is asked for has to be put back on its
-- feet: it cannot work (db/0081) or it gave up, and the tile is not yet
-- published at the version it is at.
CREATE FUNCTION job_needs_reviving(p_job bigint, t tile) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT (NOT job_can_work(p_job) OR job_gave_up(p_job))
   AND t.published_version < t.expected_version;
$$;

REVOKE ALL ON FUNCTION job_needs_reviving(bigint, tile) FROM PUBLIC;

-- db/0110's ensure_job, reviving a job that gave up as well as one that
-- cannot work. Otherwise unchanged.
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
    IF t.z IS null THEN
        RAISE EXCEPTION 'no such tile %/%/%', z, x, y;
    END IF;
    IF t.expected_version = 0 THEN
        RAISE EXCEPTION 'tile %/%/% has no world input yet', z, x, y;
    END IF;

    IF bounty <= 0
       AND current_user_role() <> 'admin'
       AND coalesce(current_setting('splatworld.rebuild', true), '') <> '1'
       AND NOT EXISTS (
           SELECT 1 FROM area
           WHERE st_intersects(area.geom, tile_bbox(z, x, y))
             AND is_area_writer(area.id)) THEN
        RAISE EXCEPTION 'not authorised for %/%/% and no bounty attached', z, x, y;
    END IF;

    -- The job of this version, if it is still a job (db/0109). Asked for
    -- again, one that gave up starts over.
    jid := live_job(z, x, y, t.expected_version);
    IF jid IS NOT null THEN
        IF job_needs_reviving(jid, t) THEN
            PERFORM revive_job(jid);
        END IF;
        RETURN jid;
    END IF;

    FOR old IN SELECT id FROM job
               WHERE job.z = ensure_job.z AND job.x = ensure_job.x
                 AND job.y = ensure_job.y AND job.state = 'open'
                 AND job.target_version < t.expected_version LOOP
        UPDATE job SET state = 'cancelled' WHERE id = old;
        PERFORM refund_bounty(old);
    END LOOP;

    BEGIN
        INSERT INTO job (z, x, y, target_version)
        VALUES (z, x, y, t.expected_version) RETURNING id INTO jid;
    EXCEPTION WHEN unique_violation THEN
        -- Another session opened this same job while this one was looking.
        jid := live_job(z, x, y, t.expected_version);
        IF jid IS null THEN
            RAISE;
        END IF;
        IF job_needs_reviving(jid, t) THEN
            PERFORM revive_job(jid);
        END IF;
        RETURN jid;
    END;
    PERFORM build_dag(jid, z, x, y);
    -- A dependency verified before this job existed is still verified.
    PERFORM advance_atoms(jid);
    -- Everything it asked for was already done: publish it now.
    IF NOT job_can_work(jid) THEN
        PERFORM revive_job(jid);
    END IF;
    IF bounty > 0 THEN
        PERFORM set_bounty(jid, bounty);
    END IF;
    RETURN jid;
END
$$;
