-- 0084_buildingitagainclearswhatitreplaces.sql — asking for a tile to be built
-- again takes the job that was building it out of the pool.
--
-- Both ways of saying "build this ground again" — "Compile it all again"
-- (recompile_land) and picking a finer detail (set_area_detail) — bump every
-- covered tile's `expected_version`. Every job already open on those tiles is
-- pinned to the version before the bump, and Invariant 3 means it can finish
-- every atom it has and publish none of them: publish_tile is a compare-and-
-- swap on expected_version.
--
-- Nothing cancelled them. `ensure_job` does cancel the superseded jobs of a
-- tile, but only when a new job is opened on it, which is after Submit and an
-- approval. Until then the old jobs sat `open`, out of render_pool (which
-- filters on target_version = expected_version), holding whatever bounty was
-- escrowed on them, and there was no way to remove them. A person who picked
-- detail 18 on a piece of land they had already submitted got a pool full of
-- work nobody could finish and no button that touched it.
--
-- So the bump cancels them where it happens. Invariant 4 is untouched: this
-- creates no job and no atom, it closes the ones the world has moved past.
-- Invariant 5: the escrow goes back through refund_bounty, whose transfers are
-- ref-idempotent, so cancelling a job twice pays nobody twice.

-- Every open job on this ground that is building a version the world has moved
-- past. Returns how many were closed.
CREATE FUNCTION supersede_jobs(p_geom geometry) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    j   bigint;
    n   int := 0;
BEGIN
    -- Coarse before fine (db/0010_lockorder.sql).
    FOR j IN SELECT job.id FROM job
             INNER JOIN tile t ON t.z = job.z AND t.x = job.x AND t.y = job.y
             WHERE job.state = 'open'
               AND job.target_version < t.expected_version
               AND st_intersects(p_geom, tile_bbox(job.z, job.x, job.y))
             ORDER BY job.z, job.x, job.y LOOP
        UPDATE job SET state = 'cancelled' WHERE id = j;
        PERFORM refund_bounty(j);
        n := n + 1;
    END LOOP;
    RETURN n;
END
$$;

REVOKE ALL ON FUNCTION supersede_jobs(geometry) FROM PUBLIC;

-- db/0081_compileitagain.sql's recompile_land, clearing the pool of what it
-- has just replaced.
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
    SELECT t.z, t.x, t.y, true, 1
    FROM tiles_for_geom(a.geom, 6, a.detail) AS t
    ORDER BY t.z, t.x, t.y
    ON CONFLICT (z, x, y) DO UPDATE
    SET dirty = true, expected_version = tile.expected_version + 1;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM supersede_jobs(a.geom);
    RETURN n;
END
$$;

-- db/0038_authoring.sql's set_area_detail, the same way. Only the deepening
-- branch bumps anything, so only that branch has anything to clear.
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
    SELECT a2.detail INTO p_detail FROM area a2 WHERE a2.id = p_area;
    IF p_detail > a.detail THEN
        INSERT INTO tile (z, x, y, dirty, expected_version)
        SELECT t.z, t.x, t.y, true, 1
        FROM tiles_for_geom(a.geom, 6, p_detail) AS t
        ORDER BY t.z, t.x, t.y
        ON CONFLICT (z, x, y) DO UPDATE
        SET dirty = true, expected_version = tile.expected_version + 1;
        GET DIAGNOSTICS n = ROW_COUNT;
        PERFORM supersede_jobs(a.geom);
    END IF;
    RETURN n;
END
$$;

-- And the ones already stranded, which no button reaches. Every one of these
-- is a job pinned to a version its tile has moved past: it cannot publish, the
-- pool does not offer it, and it is holding somebody's escrow.
DO $$
DECLARE
    j bigint;
    n int := 0;
BEGIN
    FOR j IN SELECT job.id FROM job
             INNER JOIN tile t ON t.z = job.z AND t.x = job.x AND t.y = job.y
             WHERE job.state = 'open' AND job.target_version < t.expected_version
             ORDER BY job.z, job.x, job.y LOOP
        UPDATE job SET state = 'cancelled' WHERE id = j;
        PERFORM refund_bounty(j);
        n := n + 1;
    END LOOP;
    RAISE NOTICE '0084: % superseded job(s) closed', n;
END
$$;
