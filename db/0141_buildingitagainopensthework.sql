-- 0141_buildingitagainopensthework.sql — "build it all again" puts the land
-- back in the pool instead of taking it out.
--
-- What was seen: a world with hundreds of open jobs and not one of them within
-- five kilometres of the player's own land, which they had just asked to be
-- built again.
--
-- recompile_land marks every tile the land earns dirty, bumps its
-- expected_version, and calls supersede_jobs to cancel the jobs that were
-- building the version it has just replaced (db/0084) — which is right, those
-- jobs are stale. Then it returns. Nothing opens a job at the new version, and
-- render_pool lists a job only where `job.target_version = tile.expected_version`
-- (db/0132), so the land vanishes from the pool and the nearest entry is the
-- first tile outside it. Pressing the button made the tile *less* likely to be
-- rendered than leaving it alone.
--
-- compile_ground has always had the other half — mark, supersede, then
-- ensure_job over what it marked (db/0104) — and this is the same half, over
-- the tiles of one land. set_area_detail has the same shape and the same hole:
-- raising a land to 16 made the z16 tiles and opened nothing to build them.
--
-- Jobs are opened for z14 and finer only. Below that a tile is merged from its
-- children (is_leaf_tile, db/0135) and its job opens when they are published;
-- ensure_job on it now would make a merge atom with nothing to merge, which
-- render_pool filters out anyway.
--
-- Invariant 4 holds: no job or atom is made anywhere new — ensure_job is still
-- the only thing that opens one, and it is still idempotent. The rebuild flag
-- is set for the loop exactly as compile_ground sets it (db/0070), because the
-- tiles a land earns may reach past the land itself.
CREATE FUNCTION open_land_jobs(p_area uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    at record;
    n  int := 0;
BEGIN
    PERFORM set_config('splatworld.rebuild', '1', true);
    FOR at IN SELECT t.z, t.x, t.y FROM area_tiles(p_area) AS t
              WHERE t.z >= 14 ORDER BY t.z DESC, t.x, t.y LOOP
        IF job_outcome(ensure_job(at.z, at.x, at.y)) = 'open' THEN
            n := n + 1;
        END IF;
    END LOOP;
    PERFORM set_config('splatworld.rebuild', '', true);
    RETURN n;
END
$$;

REVOKE ALL ON FUNCTION open_land_jobs(uuid) FROM PUBLIC;

-- db/0098's recompile_land, opening the work it has just asked for.
CREATE OR REPLACE FUNCTION recompile_land(p_area uuid) RETURNS int
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

    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT t.z, t.x, t.y, true, 1 FROM area_tiles(p_area) AS t
    ORDER BY t.z, t.x, t.y
    ON CONFLICT (z, x, y) DO UPDATE
    SET dirty = true, expected_version = tile.expected_version + 1;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM supersede_jobs(a.geom);
    PERFORM withdraw_submissions(p_area);
    PERFORM open_land_jobs(p_area);
    RETURN n;
END
$$;

-- db/0098's set_area_detail, the same: the tiles a land has just earned are
-- work, and work that nothing opens is not in the pool.
CREATE OR REPLACE FUNCTION set_area_detail(p_area uuid, p_detail int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a area%rowtype;
    n int := 0;
BEGIN
    SELECT * INTO a FROM area WHERE area.id = p_area FOR UPDATE;
    IF a.id IS null THEN
        RAISE EXCEPTION 'no such area %', p_area;
    END IF;
    IF NOT is_area_owner(p_area) THEN
        RAISE EXCEPTION 'not your area' USING errcode = '42501';
    END IF;
    UPDATE area SET detail = p_detail WHERE area.id = p_area;
    IF p_detail > a.detail THEN
        INSERT INTO tile (z, x, y, dirty, expected_version)
        SELECT t.z, t.x, t.y, true, 1 FROM area_tiles(p_area) AS t
        ORDER BY t.z, t.x, t.y
        ON CONFLICT (z, x, y) DO UPDATE
        SET dirty = true, expected_version = tile.expected_version + 1;
        GET DIAGNOSTICS n = ROW_COUNT;
        PERFORM supersede_jobs(a.geom);
        PERFORM withdraw_submissions(p_area);
        PERFORM open_land_jobs(p_area);
    END IF;
    RETURN n;
END
$$;
