-- 0110_adroppedjobdoesnotholdtheversion.sql — a version a dropped job was
-- opened at can be asked for again, and two tabs asking at once open one job.
--
-- What was seen: "duplicate key value violates unique constraint
-- job_z_x_y_target_version_key" on ground with no jobs left on it at all.
--
-- The two halves of it were already here. db/0109 stopped a cancelled job
-- standing in for the next one: ensure_job looks past it and opens a new job.
-- db/0105 made dropping a job wind the tile's expected_version back to what is
-- published. So a tile whose job was dropped at version 3 goes back to 0, and
-- the next three changes to that ground bring it to 3 again — where a
-- cancelled job is still holding (z, x, y, 3) in a unique constraint that
-- counts every job, whatever its state. The insert threw, and the throw took
-- the whole transaction with it: the approval, the publish, the ladder above
-- it. Nothing was left, which is why the pool looked empty afterwards.
--
-- The constraint is what has to give: it says what Invariant 4 means — one job
-- per (tile, version) — but a cancelled job is not one, it is history.
-- So the key holds over the jobs that are still jobs.
ALTER TABLE job DROP CONSTRAINT job_z_x_y_target_version_key;
CREATE UNIQUE INDEX job_live_version_idx ON job (z, x, y, target_version)
    WHERE state <> 'cancelled';

-- The job of a tile at a version that is still a job. A cancelled one is not
-- an answer to "is this being built?" (db/0109); it is what was dropped.
CREATE FUNCTION live_job(p_z int, p_x int, p_y int, p_version bigint) RETURNS bigint
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT id FROM job
WHERE job.z = p_z AND job.x = p_x AND job.y = p_y
  AND job.target_version = p_version AND job.state <> 'cancelled'
ORDER BY id DESC LIMIT 1;
$$;

REVOKE ALL ON FUNCTION live_job(int, int, int, bigint) FROM PUBLIC;

-- And the same insert, seen from another session. ensure_job looked for the
-- job of (tile, version), found none, and inserted one; between the look and
-- the insert another transaction — a second tab, a worker publishing a child
-- (publish_sog asks for the parent), an approval of the same ground — could
-- commit that very job, and this one died on the key. Invariant 4 says
-- ensure_job is idempotent on (tile, version), and that has to hold against
-- another session as well as against a second call: the loser waits for the
-- winner and is handed its job, the way it would have been had it looked a
-- moment later. Whoever won built the DAG; the loser builds nothing.
--
-- Invariant 4 holds: this is still the only place a job is created, and it now
-- creates at most one live job per (tile, version) however many ask at once.
-- db/0109's ensure_job otherwise unchanged.
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

    -- The job of this version, if it is still a job: open, or done and
    -- published. A cancelled one is not; it is left where it is (db/0109).
    jid := live_job(z, x, y, t.expected_version);
    IF jid IS NOT null THEN
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

    BEGIN
        INSERT INTO job (z, x, y, target_version)
        VALUES (z, x, y, t.expected_version) RETURNING id INTO jid;
    EXCEPTION WHEN unique_violation THEN
        -- Another session opened this same job while this one was looking.
        jid := live_job(z, x, y, t.expected_version);
        IF jid IS null THEN
            RAISE;
        END IF;
        IF NOT job_can_work(jid)
           AND t.published_version < t.expected_version THEN
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
