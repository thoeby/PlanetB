-- 0081_compileitagain.sql — a tile that was rendered can be rendered again,
-- and a job that cannot finish stops pretending it will.
--
-- Two things a person met and had no way out of.
--
-- One: submitting a piece of land that has already been compiled, approving
-- it, and finding nothing in the render pool. `ensure_job` is idempotent on
-- (tile, expected_version) — Invariant 4 — and returns whatever job it finds
-- there. If that job can no longer produce anything, the approval opened
-- nothing, `tile_state` said "queued", and the tile sat there for ever. A job
-- gets into that state when every atom of it finished but the publish did not
-- land: a compare-and-swap it lost (Invariant 3), or a tab that submitted its
-- last atom and went away. So: a job that cannot work is revived rather than
-- handed back, which re-runs a deterministic computation and publishes it.
--
-- Two: there was no way to ask for a tile to be compiled again at all. The
-- world's recipe moves — a rule changes, a sampler gets a new version
-- (db/0080_onesky.sql) — and the tiles do not, because nothing about the land
-- changed. `recompile_land` is the owner saying "build it again from what is
-- there now": it marks the ground changed, and it then goes through Submit and
-- an approval like anything else (SPEC §0.2).

-- Whether this job still has work in it. A job whose atoms are all done but
-- whose tile is not published is finished and useless, which is the state
-- nothing could see.
CREATE FUNCTION job_can_work(p_job bigint) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT EXISTS (SELECT 1 FROM job j WHERE j.id = p_job AND j.state = 'open')
   AND EXISTS (SELECT 1 FROM atom a WHERE a.job_id = p_job
               AND a.state IN ('waiting', 'ready', 'claimed', 'submitted'));
$$;

GRANT EXECUTE ON FUNCTION job_can_work(bigint) TO anon, player, admin;

-- Getting a stuck job moving again, in the two shapes it comes in.
--
-- Anything that did not finish goes back to the start: the atom is unchanged —
-- same inputs, same params, same seed, same atom_hash (Invariant 2) — so it
-- re-runs the same computation and lands the same bytes at the same address.
--
-- A job whose every atom is verified has nothing left to compute: what it is
-- missing is the publish, which is a pointer update that lost its
-- compare-and-swap or never ran because the tab that would have made it went
-- away. That one is re-attempted from what the atom itself recorded. A
-- verified atom is never reset: it has been checked, and unchecking it is not
-- a thing a state machine should let anybody do (db/0005_state.sql).
CREATE FUNCTION revive_job(p_job bigint) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    n int := 0;
    a atom%rowtype;
BEGIN
    UPDATE atom SET state = CASE WHEN cardinality(deps) = 0 THEN 'ready'
                                 ELSE 'waiting' END,
                    attempts = 0, output_sha256 = null, result = null,
                    worker_id = null, claimed_at = null, heartbeat_at = null
    WHERE job_id = p_job AND state IN ('claimed', 'submitted', 'failed');
    GET DIAGNOSTICS n = ROW_COUNT;
    UPDATE job SET state = 'open' WHERE id = p_job AND state <> 'cancelled';
    PERFORM advance_atoms(p_job);
    IF n = 0 THEN
        SELECT * INTO a FROM atom
        WHERE job_id = p_job AND op = 'sog' AND state = 'verified'
          AND output_sha256 IS NOT null
        ORDER BY id DESC LIMIT 1;
        IF a.id IS NOT null AND a.result ? 'manifest' THEN
            PERFORM publish_sog(a, (SELECT user_id FROM worker WHERE id = a.worker_id),
                                a.result -> 'manifest');
            n := 1;
        END IF;
    END IF;
    RETURN n;
END
$$;

GRANT EXECUTE ON FUNCTION revive_job(bigint) TO player, admin;

-- db/0070_therebuildopensitself.sql's ensure_job, with the one question added.
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

    SELECT id INTO jid FROM job
    WHERE job.z = ensure_job.z AND job.x = ensure_job.x AND job.y = ensure_job.y
      AND job.target_version = t.expected_version;
    IF jid IS NOT null THEN
        -- A job that still has work in it is the job (Invariant 4). One that
        -- has none and did not publish is a dead end nobody could see: the
        -- pool does not list it, the tile says "queued", and asking for it
        -- again returned this same job.
        IF NOT job_can_work(jid)
           AND t.published_version < t.expected_version THEN
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

    INSERT INTO job (z, x, y, target_version)
    VALUES (z, x, y, t.expected_version) RETURNING id INTO jid;
    PERFORM build_dag(jid, z, x, y);
    IF bounty > 0 THEN
        PERFORM set_bounty(jid, bounty);
    END IF;
    RETURN jid;
END
$$;

-- "Build it again." Nothing about the land changed, so nothing marked it
-- changed — but the recipe did, and the only way to get a tile built the new
-- way is to say so. It marks the ground, and from there it is Submit and an
-- approval like anything else: this does not open a job and does not spend
-- anybody's tab without being asked (SPEC §0.2).
CREATE FUNCTION recompile_land(p_area uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    a area%rowtype;
    n int := 0;
BEGIN
    SELECT * INTO a FROM area WHERE area.id = p_area;
    IF a.id IS null THEN
        RAISE EXCEPTION 'no such area %', p_area USING errcode = '23503';
    END IF;
    IF NOT (is_area_owner(p_area) OR current_user_role() = 'admin') THEN
        RAISE EXCEPTION 'that is not your land to compile' USING errcode = '42501';
    END IF;

    -- Coarse before fine (db/0010_lockorder.sql).
    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT t.z, t.x, t.y, true, 1
    FROM tiles_for_geom(a.geom, 6, a.detail) AS t
    ORDER BY t.z, t.x, t.y
    ON CONFLICT (z, x, y) DO UPDATE
    SET dirty = true, expected_version = tile.expected_version + 1;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END
$$;

GRANT EXECUTE ON FUNCTION recompile_land(uuid) TO player, admin;

CREATE FUNCTION api.recompile_land(area_id uuid) RETURNS int
LANGUAGE sql VOLATILE SET search_path = public AS $$
SELECT public.recompile_land(area_id);
$$;

GRANT EXECUTE ON FUNCTION api.recompile_land(uuid) TO player, admin;
