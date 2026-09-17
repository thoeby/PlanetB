-- 0130_thegroundcallsthesridtoo.sql — the last two function bodies that spell
-- a CRS out call world_srid() instead.
--
-- db/0056_crs.sql: an EPSG code is written in exactly one place per language,
-- and in SQL that place is world_srid() / tile_srid(). set_ground (db/0104) and
-- set_ground_layer (db/0106) were written with 4326 in the envelope they build
-- and have been what server/test_crs_agree.py names ever since. Same bodies,
-- same behaviour — world_srid() is 4326 — with the number asked for rather
-- than repeated.
CREATE OR REPLACE FUNCTION set_ground(p_url text, p_coverage text,
                                      p_west double precision,
                                      p_south double precision,
                                      p_east double precision,
                                      p_north double precision)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid   uuid := current_user_id();
    box   geometry;
    n     int := 0;
    first boolean := NOT EXISTS (SELECT 1 FROM ground);
BEGIN
    IF uid IS null THEN
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
                           least(p_east, 180), least(p_north, 85.06),
                           world_srid());

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

CREATE OR REPLACE FUNCTION set_ground_layer(p_kind text, p_url text, p_layer text,
                                            p_west double precision,
                                            p_south double precision,
                                            p_east double precision,
                                            p_north double precision,
                                            p_priority int DEFAULT 0)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    lid int;
BEGIN
    IF current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin changes the ground' USING errcode = '42501';
    END IF;
    IF p_west >= p_east OR p_south >= p_north
       OR abs(p_west) > 180 OR abs(p_east) > 180
       OR abs(p_south) > 90 OR abs(p_north) > 90 THEN
        RAISE EXCEPTION 'that extent is not longitude and latitude';
    END IF;
    INSERT INTO ground_layer (kind, geoserver_url, layer, extent, priority, set_by)
    VALUES (p_kind, p_url, p_layer,
            st_makeenvelope(p_west, greatest(p_south, -85.06),
                            p_east, least(p_north, 85.06), world_srid()),
            p_priority, current_user_id())
    RETURNING id INTO lid;
    DELETE FROM geo_tile;
    RETURN lid;
END
$$;
