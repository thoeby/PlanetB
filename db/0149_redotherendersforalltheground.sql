-- 0149_redotherendersforalltheground.sql — the frames a tile was trained on,
-- found wherever they live, and asked for again a land or a world at a time.
--
-- Two things wrong with db/0147's redo_renders.
--
-- It reset `WHERE job_id = p_job AND op = 'frame'`, and an atom's job_id
-- moves: new_atom hands an unfinished or verified atom to whichever job asks
-- for it next (db/0100), so the frames a job's training actually eats are
-- often on another job's row by the time anybody presses the button. It found
-- nothing and returned 0, which read as a button that does nothing. The train
-- atom names its own frames in `deps`, so that is what to reset — wherever
-- they have got to.
--
-- And one tile at a time is not a tool. A recipe changes, or a mesh was built
-- from a cut that has since been fixed, and what needs its frames again is
-- every tile of a land or every tile there is. Three hundred presses is not
-- an answer.
CREATE OR REPLACE FUNCTION redo_renders(p_job bigint) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    j     job%rowtype;
    frame bigint [];
    n     int := 0;
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

    -- This job's frames, and the frames its training names — which may sit on
    -- another job's row after an adoption (db/0100 new_atom).
    SELECT coalesce(array_agg(DISTINCT a.id), '{}') INTO frame
    FROM atom a
    WHERE (a.job_id = p_job
           OR a.id = ANY (coalesce((SELECT t.deps FROM atom t
                                    WHERE t.job_id = p_job AND t.op = 'train'), '{}')))
      AND a.op = 'frame';
    IF cardinality(frame) = 0 THEN
        RETURN 0;
    END IF;

    -- Every state may go to `failed` and `failed` may go to `ready` or
    -- `waiting`, and `verified` may go nowhere else (db/0005_state.sql), so
    -- both moves go through it rather than around the guard.
    UPDATE atom SET state = 'failed', worker_id = null, claimed_at = null,
        heartbeat_at = null
    WHERE (id = ANY (frame) OR (job_id = p_job AND op IN ('train', 'sog', 'verify')))
      AND state <> 'failed';
    UPDATE atom SET state = 'ready', attempts = 0, handed_back = 0,
        output_sha256 = null, result = null
    WHERE id = ANY (frame);
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

-- Every open job over a piece of land. Returns how many tiles were asked
-- again, not how many frames: that is the number a person pressing this is
-- counting.
CREATE FUNCTION redo_land_renders(p_area uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a job%rowtype;
    n int := 0;
BEGIN
    IF NOT (is_area_owner(p_area) OR current_user_role() = 'admin') THEN
        RAISE EXCEPTION 'that is not your land to render again' USING errcode = '42501';
    END IF;
    FOR a IN SELECT j.* FROM job j
             INNER JOIN area ar ON ar.id = p_area
             WHERE j.state = 'open'
               AND st_intersects(ar.geom, tile_bbox(j.z, j.x, j.y))
             ORDER BY j.z DESC, j.x, j.y LOOP
        IF redo_renders(a.id) > 0 THEN
            n := n + 1;
        END IF;
    END LOOP;
    RETURN n;
END
$$;

-- And every open job the world has. Only an admin: this is the whole ground.
CREATE FUNCTION redo_ground_renders() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a job%rowtype;
    n int := 0;
BEGIN
    IF current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin renders the whole ground again'
            USING errcode = '42501';
    END IF;
    FOR a IN SELECT j.* FROM job j WHERE j.state = 'open'
             ORDER BY j.z DESC, j.x, j.y LOOP
        IF redo_renders(a.id) > 0 THEN
            n := n + 1;
        END IF;
    END LOOP;
    RETURN n;
END
$$;

REVOKE ALL ON FUNCTION redo_land_renders(uuid), redo_ground_renders() FROM PUBLIC;

CREATE FUNCTION api.redo_land_renders(area_id uuid) RETURNS int
LANGUAGE sql VOLATILE SET search_path = public AS $$
SELECT public.redo_land_renders(area_id);
$$;

CREATE FUNCTION api.redo_ground_renders() RETURNS int
LANGUAGE sql VOLATILE SET search_path = public AS $$
SELECT public.redo_ground_renders();
$$;

GRANT EXECUTE ON FUNCTION api.redo_land_renders(uuid) TO player, admin;
GRANT EXECUTE ON FUNCTION api.redo_ground_renders() TO admin;
