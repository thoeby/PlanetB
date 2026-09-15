-- 0098_compileagainmeansagain.sql — "Compile it all again" means again.
--
-- Two things still stood between pressing it and a tile being rebuilt.
--
-- A submission of the land that was still open — tiles awaiting approval at
-- the version the world has just moved past — kept every one of those tiles
-- at 'awaiting approval' (tile_state), out of Submit's count (to_submit) and
-- out of the pool: "13 tiles to submit" over a button that offered 9, and
-- approving the old submission opened jobs the person had not asked for. A
-- submission the world has moved past is withdrawn where the move happens.
-- 'withdrawn' is a fourth state (the CHECK grows by one word): not refused,
-- which would show as a refusal on the land, and not approved.
--
-- And the frames: frame-v4 rasterises (client/lib/raster.js) — three.js with
-- soft shadow maps, the sky as an environment map, filmic tone mapping and a
-- detail texture on the ground — in milliseconds a frame, where v2 and v3
-- path-traced in seconds to minutes and still needed a denoiser. The camera
-- set keeps its counts (camera_views) and stands on the ground; `samples`
-- and `bounces` go, as v4 has neither.
ALTER TABLE submission DROP CONSTRAINT submission_state_check;
ALTER TABLE submission ADD CONSTRAINT submission_state_check
    CHECK (state IN ('open', 'approved', 'refused', 'withdrawn'));

-- Every open submission of this land, withdrawn. Returns how many.
CREATE FUNCTION withdraw_submissions(p_area uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    n int := 0;
BEGIN
    UPDATE submission SET state = 'withdrawn', decided_at = now()
    WHERE area_id = p_area AND state = 'open';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END
$$;

REVOKE ALL ON FUNCTION withdraw_submissions(uuid) FROM PUBLIC;

-- db/0089's recompile_land, withdrawing what was submitted for the version
-- it moves past.
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
    RETURN n;
END
$$;

-- db/0089's set_area_detail, the same.
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
    END IF;
    RETURN n;
END
$$;

-- db/0096's build_dag with frame-v4 and no tracing parameters.
CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v1' END;
    leaf   boolean := is_leaf_tile(a_z, a_x, a_y);
    base   jsonb;
    asm    bigint;
    frames bigint [] := '{}';
    trn    bigint;
    smp    bigint;
    mrg    bigint;
    views  int := camera_views(a_z);
    chunk  int := frame_chunk();
    i      int;
    budget bigint := tile_budget(a_z);
    px     int := CASE WHEN a_z = 18 THEN 1024 ELSE 512 END;
BEGIN
    IF leaf THEN
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        asm := new_atom(a_job, 'assemble', 'assemble-v2', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, '{}');
    END IF;

    IF a_z >= 16 THEN
        i := 0;
        WHILE i < views LOOP
            frames := frames || new_atom(a_job, 'frame', 'frame-v4',
                jsonb_build_object('assemble', asm, 'snapshot', snap),
                jsonb_build_object('camera_set', cams, 'size', px,
                    'from', i, 'to', least(i + chunk, views)), 0, ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v3',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', CASE WHEN a_z = 18 THEN 2000 ELSE 1500 END,
                'size', px,
                'camera_set', cams,
                'needs_webgpu', true,
                'min_buffer_mb', ceil(96::numeric * budget / 1048576)), 0, frames);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
    ELSIF leaf THEN
        smp := new_atom(a_job, 'sample', 'sample-v3',
            jsonb_build_object('assemble', asm, 'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, ARRAY[asm]);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', smp),
            jsonb_build_object('budget', budget), 0, ARRAY[smp]);
    ELSE
        mrg := new_atom(a_job, 'merge', 'merge-v1',
            jsonb_build_object('children', child_sogs(a_z, a_x, a_y),
                               'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'voxel', 0.05, 'budget', budget), 0, '{}');
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', mrg),
            jsonb_build_object('budget', budget), 0, ARRAY[mrg]);
    END IF;
END
$$;
