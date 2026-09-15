-- 0109_acancelledjobisnotthejob.sql — a cancelled job does not stand in for
-- the next one, and "opened" counts what is open.
--
-- ensure_job looked for "the job of this tile at this version" and took any
-- row it found, whatever its state. A job dropped from the pool (db/0105) is
-- cancelled at exactly that version, so every request after it — a submit,
-- an approval, compile_ground — found the cancelled job, handed it back, and
-- approve_submission counted it: "8 render job(s) are in the pool", and the
-- pool was empty. Nothing failed; nothing was made.
--
-- Now a cancelled job is never the answer: ensure_job makes a new one beside
-- it. And approve_submission counts the jobs that are open when it is done,
-- says how many were already published, and raises if a tile came out of it
-- neither open nor published — a state that is not supposed to exist and
-- must not be reported as success.
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
    -- published. A cancelled one is not; it is left where it is.
    SELECT id INTO jid FROM job
    WHERE job.z = ensure_job.z AND job.x = ensure_job.x AND job.y = ensure_job.y
      AND job.target_version = t.expected_version AND job.state <> 'cancelled'
    ORDER BY id DESC LIMIT 1;
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

    INSERT INTO job (z, x, y, target_version)
    VALUES (z, x, y, t.expected_version) RETURNING id INTO jid;
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

-- What a request for a tile came to: 'open' (a job is in the pool),
-- 'published' (nothing to do, the tile is at its version), or an error.
CREATE FUNCTION job_outcome(p_job bigint) RETURNS text
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    j job%rowtype;
    t tile%rowtype;
BEGIN
    SELECT * INTO j FROM job WHERE id = p_job;
    SELECT * INTO t FROM tile WHERE z = j.z AND x = j.x AND y = j.y;
    IF j.state = 'open' THEN
        RETURN 'open';
    END IF;
    IF t.published_version >= j.target_version THEN
        RETURN 'published';
    END IF;
    RAISE EXCEPTION 'tile %/%/%: job % is % at version % and the tile is at % — '
        'neither in the pool nor published', j.z, j.x, j.y, j.id, j.state,
        j.target_version, t.published_version;
END
$$;

-- db/0086's approve_submission, counting what is open.
CREATE OR REPLACE FUNCTION approve_submission(p_id uuid, p_price numeric DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    s      submission%rowtype;
    a      area%rowtype;
    st     record;
    came   text;
    opened int := 0;
    done   int := 0;
BEGIN
    SELECT * INTO s FROM submission WHERE id = p_id FOR UPDATE;
    IF s.id IS null THEN
        RAISE EXCEPTION 'no such submission' USING errcode = '23503';
    END IF;
    SELECT * INTO a FROM area WHERE id = s.area_id;
    IF NOT (is_area_owner(a.id) OR has_area_right(a.id, 'approve')
            OR current_user_role() = 'admin') THEN
        RAISE EXCEPTION 'that is not your ground to approve' USING errcode = '42501';
    END IF;
    IF s.state <> 'open' THEN
        RAISE EXCEPTION 'that submission was already %', s.state
            USING errcode = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM submission_tile sub JOIN tile t2
                 ON t2.z = sub.z AND t2.x = sub.x AND t2.y = sub.y
               WHERE sub.submission_id = p_id AND t2.expected_version > sub.at_version)
    THEN
        RAISE EXCEPTION 'this changed since it was submitted — ask for it again'
            USING errcode = '23514';
    END IF;

    -- Coarse before fine, as every other writer of `tile` does
    -- (db/0010_lockorder.sql).
    FOR st IN SELECT sub.z, sub.x, sub.y FROM submission_tile sub
              WHERE sub.submission_id = p_id ORDER BY sub.z, sub.x, sub.y
    LOOP
        came := job_outcome(ensure_job(st.z, st.x, st.y, coalesce(p_price, 0)));
        IF came = 'open' THEN opened := opened + 1; ELSE done := done + 1; END IF;
    END LOOP;

    UPDATE submission SET state = 'approved', decided_at = now(),
                          decided_by = current_user_id()
    WHERE id = p_id;

    IF s.by_id <> current_user_id() AND opened > 0 THEN
        PERFORM tell(s.by_id, 'submission_approved',
                     player_name(current_user_id()) || ' approved your '
                     || opened || ' tile' || CASE WHEN opened = 1 THEN '' ELSE 's' END
                     || ' — they are in the render pool now',
                     jsonb_build_object('panel', 'Render jobs',
                                        'lon', st_x(st_pointonsurface(a.geom)),
                                        'lat', st_y(st_pointonsurface(a.geom))));
    END IF;
    RETURN jsonb_build_object('id', p_id, 'queued', opened, 'published', done);
END
$$;

-- db/0108's compile_ground, counting what is open the same way.
CREATE OR REPLACE FUNCTION compile_ground() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    g   ground%rowtype;
    at  record;
    n   int := 0;
BEGIN
    SELECT * INTO g FROM ground;
    IF g.extent IS NULL THEN
        RETURN 0;
    END IF;
    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT tg.z, tg.x, tg.y, true, 1 FROM tiles_for_geom(g.extent, 6, 14) AS tg
    ORDER BY tg.z, tg.x, tg.y
    ON CONFLICT (z, x, y) DO UPDATE
    SET dirty = true, expected_version = tile.expected_version + 1;
    PERFORM supersede_jobs(g.extent);
    PERFORM set_config('splatworld.rebuild', '1', true);
    FOR at IN SELECT tile.x, tile.y FROM tile
              WHERE tile.z = 14 AND st_intersects(tile_bbox(14, tile.x, tile.y), g.extent)
              ORDER BY tile.x, tile.y LOOP
        IF job_outcome(ensure_job(14, at.x, at.y)) = 'open' THEN
            n := n + 1;
        END IF;
    END LOOP;
    PERFORM set_config('splatworld.rebuild', '', true);
    RETURN n;
END
$$;
