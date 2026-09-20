-- 0177_thethreethatkepttheirownsrid.sql — three function bodies that a
-- database which applied db/0169 and db/0172 before they were corrected still
-- carries.
--
-- `live_near`, `mover_set` and `movers_near` were written with a bare 4326 in
-- them, which db/0056's rule forbids: the world's SRID is `world_srid()` and
-- nowhere else, so that an operator who moves the world does not leave three
-- functions behind measuring in the old one. The gate caught it and the fix
-- was made in db/0169 and db/0172 themselves — which does nothing at all for
-- a database that had already applied them. `make db-test` resets, so it was
-- green either way, and every running world kept the old bodies.
--
-- So: the same three, as those files now have them, in a migration of their
-- own. A database that never had the old ones gets exactly what it already
-- has. Nothing else changes, and no atom's inputs move (Invariant 2): these
-- read the world, they do not build it.
CREATE OR REPLACE FUNCTION live_near(p_lon double precision, p_lat double precision,
                          p_metres double precision DEFAULT 500,
                          p_since bigint DEFAULT 0)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'instance', l.instance_id, 'port', l.port, 'value', l.value,
    'rev', l.rev) ORDER BY l.rev), '[]'::jsonb)
FROM live_state l
JOIN instance i ON i.id = l.instance_id AND i.deleted_at IS null
WHERE l.rev > p_since
  AND st_dwithin(i.geom::geography,
                 st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography,
                 p_metres);
$$;

CREATE OR REPLACE FUNCTION mover_set(p_mover uuid, p_fields jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    m    mover%rowtype;
    area uuid;
    line geometry;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'sign in first' USING errcode = '42501';
    END IF;
    IF p_mover IS NOT NULL THEN
        SELECT * INTO m FROM mover WHERE id = p_mover AND deleted_at IS null;
        IF m.id IS NULL THEN
            RAISE EXCEPTION 'no such mover %', p_mover USING errcode = '23503';
        END IF;
    END IF;
    area := coalesce((p_fields ->> 'area')::uuid, m.area_id);
    IF area IS NULL THEN
        RAISE EXCEPTION 'a mover runs on somebody''s land' USING errcode = '23502';
    END IF;
    IF NOT is_area_writer(area) THEN
        RAISE EXCEPTION 'that is not your land' USING errcode = '42501';
    END IF;

    m.area_id := area;
    m.san := coalesce(p_fields ->> 'san', m.san);
    m.name := coalesce(p_fields ->> 'name', m.name, '');
    IF p_fields ? 'route_feature' THEN
        m.route_feature := (p_fields ->> 'route_feature')::uuid;
        m.route := null;
    ELSIF p_fields ? 'route' THEN
        m.route := st_setsrid(st_geomfromgeojson(p_fields -> 'route'), world_srid());
        m.route_feature := null;
    END IF;
    m.speed_kmh := coalesce((p_fields ->> 'speed_kmh')::numeric, m.speed_kmh, 30);
    m.schedule := coalesce(p_fields -> 'schedule', m.schedule,
                           '{"every_s": 600, "loop": "circle"}'::jsonb);
    m.phase_s := coalesce((p_fields ->> 'phase_s')::numeric, m.phase_s, 0);
    IF p_fields ? 'paused' THEN m.paused := (p_fields ->> 'paused')::boolean; END IF;
    m.paused := coalesce(m.paused, false);

    IF m.san IS NULL THEN
        RAISE EXCEPTION 'a mover is something you can see' USING errcode = '23502';
    END IF;
    PERFORM check_schedule(m.schedule);

    line := coalesce(m.route,
        (SELECT st_force2d(f.geom) FROM feature f WHERE f.id = m.route_feature));
    IF line IS NULL OR st_geometrytype(line) <> 'ST_LineString' THEN
        RAISE EXCEPTION 'a mover runs along a line — a road it owns, or one'
                        ' drawn on the ground' USING errcode = '22023';
    END IF;
    -- Invariant 6: the land says where its buses may go, not the page.
    IF NOT route_is_theirs(area, line) THEN
        RAISE EXCEPTION 'that route leaves the land' USING errcode = '42501';
    END IF;

    IF p_mover IS NULL THEN
        INSERT INTO mover (area_id, san, name, route_feature, route, speed_kmh,
                           schedule, phase_s, paused)
        VALUES (m.area_id, m.san, m.name, m.route_feature, m.route, m.speed_kmh,
                m.schedule, m.phase_s, m.paused)
        RETURNING * INTO m;
    ELSE
        UPDATE mover SET area_id = m.area_id, san = m.san, name = m.name,
                         route_feature = m.route_feature, route = m.route,
                         speed_kmh = m.speed_kmh, schedule = m.schedule,
                         phase_s = m.phase_s, paused = m.paused,
                         rev = mover.rev + 1
        WHERE id = p_mover RETURNING * INTO m;
    END IF;
    RETURN one_mover(m.id);
END
$$;

CREATE OR REPLACE FUNCTION movers_near(p_lon double precision, p_lat double precision,
                            p_metres double precision DEFAULT 2000) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(public.one_mover(m.id) ORDER BY m.id), '[]'::jsonb)
FROM mover m
WHERE m.deleted_at IS null
  AND st_dwithin(public.mover_line(m)::geography,
                 st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography, p_metres);
$$;
