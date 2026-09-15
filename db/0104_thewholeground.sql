-- 0104_thewholeground.sql — the whole ground is rendered, at z14, always.
--
-- Until now a tile was compiled only where somebody had claimed land, and
-- everywhere else the viewer drew a mesh of the raw elevation in a look of its
-- own. That mesh is gone from the client: it was a second renderer beside the
-- frames, and the two met at every edge as a seam. Instead every z14 tile the
-- ground's extent touches is a job, whether or not anything stands on it,
-- and the z14 tile goes through the same frames and training as a z16 — one
-- renderer (client/lib/raster.js), one look. The sampled baseline is gone
-- with the mesh, so is `sample`.
--
-- compile_ground() makes the tiles and the jobs. set_ground() calls it, so a
-- world is rendering from the moment its ground is chosen; an admin calls it
-- again from Setup when the recipe changes. The jobs need no land under them:
-- ensure_job is asked with splatworld.rebuild set, as recompile_land does.
--
-- The training steps go back to what they were before db/0101: 1 500, and
-- 2 000 at z18.

CREATE OR REPLACE FUNCTION camera_views(z int) RETURNS int
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE z WHEN 18 THEN 120 WHEN 16 THEN 56 WHEN 14 THEN 56 ELSE 0 END;
$$;

-- db/0103's build_dag: the z14 branch trains, and there is no sampler.
CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v1' END;
    base   jsonb;
    asm    bigint;
    frames bigint [] := '{}';
    trn    bigint;
    mrg    bigint;
    views  int := camera_views(a_z);
    chunk  int := frame_chunk();
    i      int;
    budget bigint := tile_budget(a_z);
    px     int := 1024;
BEGIN
    IF a_z >= 14 THEN
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        asm := new_atom(a_job, 'assemble', 'assemble-v4', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, '{}');
        i := 0;
        WHILE i < views LOOP
            frames := frames || new_atom(a_job, 'frame', 'frame-v6',
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

-- Every tile of the ground down to z14, and a job for each z14. Returns how
-- many z14 jobs there are. Internal: set_ground and api.compile_ground call it.
CREATE FUNCTION compile_ground() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    g   ground%rowtype;
    t   record;
    n   int := 0;
BEGIN
    SELECT * INTO g FROM ground;
    IF g.extent IS NULL THEN
        RETURN 0;
    END IF;
    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT t.z, t.x, t.y, true, 1 FROM tiles_for_geom(g.extent, 6, 14) AS t
    ORDER BY t.z, t.x, t.y
    ON CONFLICT (z, x, y) DO UPDATE
    SET dirty = true, expected_version = tile.expected_version + 1;
    PERFORM supersede_jobs(g.extent);
    PERFORM set_config('splatworld.rebuild', '1', true);
    FOR t IN SELECT tile.x, tile.y FROM tile
             WHERE tile.z = 14 AND st_intersects(tile_bbox(14, tile.x, tile.y), g.extent)
             ORDER BY tile.x, tile.y LOOP
        PERFORM ensure_job(14, t.x, t.y);
        n := n + 1;
    END LOOP;
    PERFORM set_config('splatworld.rebuild', '', true);
    RETURN n;
END
$$;
REVOKE ALL ON FUNCTION compile_ground() FROM PUBLIC;

CREATE FUNCTION api.compile_ground() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin renders the whole ground' USING errcode = '42501';
    END IF;
    RETURN compile_ground();
END
$$;
GRANT EXECUTE ON FUNCTION api.compile_ground() TO admin;

-- db/0049's set_ground, rendering the ground it has just set.
CREATE OR REPLACE FUNCTION set_ground(p_url text, p_coverage text,
                           p_west double precision, p_south double precision,
                           p_east double precision, p_north double precision)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid   uuid := current_user_id();
    box   geometry;
    n     int := 0;
    first boolean := NOT EXISTS (SELECT 1 FROM ground);
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    IF NOT first AND current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin moves the world' USING errcode = '42501';
    END IF;
    IF p_west >= p_east OR p_south >= p_north THEN
        RAISE EXCEPTION 'that coverage has no extent';
    END IF;
    IF abs(p_west) > 180 OR abs(p_east) > 180
       OR abs(p_south) > 90 OR abs(p_north) > 90 THEN
        RAISE EXCEPTION 'that extent is not longitude and latitude: % % to % %.'
            ' The coverage published its envelope in its own projection;'
            ' publish it in WGS84 as well, or pick a coverage that does',
            p_west, p_south, p_east, p_north;
    END IF;
    box := st_makeenvelope(greatest(p_west, -180), greatest(p_south, -85.06),
                           least(p_east, 180), least(p_north, 85.06), 4326);

    INSERT INTO ground (only_one, geoserver_url, coverage, extent, set_by)
    VALUES (true, p_url, p_coverage, box, uid)
    ON CONFLICT (only_one) DO UPDATE
    SET geoserver_url = excluded.geoserver_url, coverage = excluded.coverage,
        extent = excluded.extent, set_at = now(), set_by = excluded.set_by;

    -- The cut tiles were cut from the old coverage; the compiled ones are
    -- dirtied by compile_ground, which builds the new one whole.
    DELETE FROM geo_tile;
    n := compile_ground();
    RETURN jsonb_build_object('dirtied', n, 'coverage', p_coverage);
END
$$;
