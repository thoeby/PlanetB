-- 0049_groundislonlat.sql — an extent that is not longitude and latitude is an
-- error, not something to clamp.
--
-- set_ground() clipped whatever it was given to the world's range, so a
-- coverage whose envelope came back in LV95 metres (2633000 1124000 — a Swiss
-- DEM's native CRS) was stored as
--   POLYGON((2633000 1124000, 2633000 85.06, 180 85.06, 180 1124000, ...))
-- and every tile in Switzerland was then "outside the world's coverage". The
-- reading was fixed in server/splatworld/geoserver.py; this makes the database
-- refuse to hold the nonsense in the first place.
--
-- The clamp stays for the one thing it is for: a coverage that legitimately
-- runs to the poles, where Web Mercator stops at 85.06.
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

    UPDATE tile t SET dirty = true, expected_version = t.expected_version + 1
    WHERE t.expected_version > 0 AND st_intersects(tile_bbox(t.z, t.x, t.y), box);
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM geo_tile;
    RETURN jsonb_build_object('dirtied', n, 'coverage', p_coverage);
END
$$;
