-- 0147_theframescanbeaskedforagain.sql — a tile's frames can be asked for
-- again without throwing the tile away.
--
-- A training run is only as good as the views it was shown. When the frames
-- are wrong — a mesh built from a coarse cut, a camera set that has moved, a
-- renderer that has been fixed since — the trained tile is wrong with them,
-- and the only way back was to compile the whole tile again from the ground
-- up, which throws away the assemble as well and opens a new version.
--
-- `redo_renders` puts the frames back to `ready` and everything that eats
-- them back to `waiting`. Invariant 1 holds: no artifact is unmade, the old
-- frames keep their bytes at their own addresses. Invariant 4 holds: no atom
-- and no job is created — these are the same atoms, at the same hashes, run
-- again. Invariant 2 holds: nothing about what they are asked to compute
-- changes, so what comes back is what should have come back the first time.
--
-- Only somebody who could have opened the job may do it: the land's writer,
-- or an admin (the rule ensure_job uses, db/0100).
CREATE FUNCTION redo_renders(p_job bigint) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    j job%rowtype;
    n int := 0;
BEGIN
    SELECT * INTO j FROM job WHERE id = p_job FOR UPDATE;
    IF j.id IS null THEN
        RAISE EXCEPTION 'no such job %', p_job USING errcode = '23503';
    END IF;
    IF j.state <> 'open' THEN
        RAISE EXCEPTION 'job % is %, so its frames are not the world''s any more',
            p_job, j.state USING errcode = '23514';
    END IF;
    IF current_user_role() <> 'admin'
       AND NOT EXISTS (SELECT 1 FROM area
                       WHERE st_intersects(area.geom, tile_bbox(j.z, j.x, j.y))
                         AND is_area_writer(area.id)) THEN
        RAISE EXCEPTION 'that tile is not yours to render again' USING errcode = '42501';
    END IF;

    -- The frames run again; what was built from them waits for them. Every
    -- state may go to `failed` and `failed` may go to `ready` or `waiting`,
    -- and `verified` may go nowhere else at all (db/0005_state.sql), so both
    -- moves go through it rather than around the guard.
    UPDATE atom SET state = 'failed', worker_id = null, claimed_at = null,
        heartbeat_at = null
    WHERE job_id = p_job AND op IN ('frame', 'train', 'sog', 'verify')
      AND state <> 'failed';
    UPDATE atom SET state = 'ready', attempts = 0, handed_back = 0,
        output_sha256 = null, result = null
    WHERE job_id = p_job AND op = 'frame';
    GET DIAGNOSTICS n = ROW_COUNT;
    UPDATE atom SET state = 'waiting', attempts = 0, handed_back = 0,
        output_sha256 = null, result = null
    WHERE job_id = p_job AND op IN ('train', 'sog', 'verify');

    INSERT INTO tile_event (z, x, y, job_id, op, kind, detail)
    VALUES (j.z, j.x, j.y, j.id, 'frame', 'handed_back',
            n || ' frame(s) asked for again, and the training with them');
    PERFORM advance_atoms(p_job);
    RETURN n;
END
$$;

REVOKE ALL ON FUNCTION redo_renders(bigint) FROM PUBLIC;

CREATE FUNCTION api.redo_renders(job_id bigint) RETURNS int
LANGUAGE sql VOLATILE SET search_path = public AS $$
SELECT public.redo_renders(job_id);
$$;

GRANT EXECUTE ON FUNCTION api.redo_renders(bigint) TO player, admin;
