-- 0172_amoverissetandunset.sql — what a player does to a mover.
--
-- TASKS-foundation.md FND.16, second half. db/0171 holds what a mover is;
-- this is the one verb that makes and changes one, and the two reads the page
-- needs. FND.14 left `mover_set` refusing everybody with "flows do not run
-- yet"; it now answers a player, and goes on refusing a flow, which has no
-- login of its own until F10.
--
-- Nothing here dirties a tile or opens a job. A bus is not on the land, it
-- moves over it.

-- Making one or changing one, in the fields somebody actually typed. `p_mover`
-- null is a new one; anything the fields do not mention is left as it was.
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

GRANT EXECUTE ON FUNCTION mover_set(uuid, jsonb) TO player, admin;

-- Taking one off the land. It leaves a tombstone, because somebody's tab may
-- be drawing it and has to be told it is gone rather than left guessing.
CREATE FUNCTION mover_drop(p_mover uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    area uuid;
BEGIN
    SELECT area_id INTO area FROM mover WHERE id = p_mover AND deleted_at IS null;
    IF area IS NULL THEN RETURN false; END IF;
    IF NOT is_area_writer(area) THEN
        RAISE EXCEPTION 'that is not your land' USING errcode = '42501';
    END IF;
    UPDATE mover SET deleted_at = now(), rev = rev + 1 WHERE id = p_mover;
    RETURN true;
END
$$;

GRANT EXECUTE ON FUNCTION mover_drop(uuid) TO player, admin;

-- ----------------------------------------------------------------- the reads

-- One mover, as every panel and the 3D view read one: its line as points, so
-- the page can work out where it is without knowing any geometry (FND.16,
-- client/lib/route.js).
CREATE FUNCTION one_mover(p_mover uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object(
    'id', m.id, 'area', m.area_id, 'san', m.san, 'name', m.name,
    'sha256', a.sha256, 'speed_kmh', m.speed_kmh, 'schedule', m.schedule,
    'phase_s', m.phase_s, 'paused', m.paused, 'rev', m.rev,
    'route_feature', m.route_feature,
    'route', (SELECT jsonb_agg(jsonb_build_array(st_x(p.geom), st_y(p.geom))
                               ORDER BY p.path)
              FROM st_dumppoints(public.mover_line(m)) AS p))
FROM mover m JOIN asset a ON a.san = m.san
WHERE m.id = p_mover AND m.deleted_at IS null;
$$;

GRANT EXECUTE ON FUNCTION one_mover(uuid) TO anon, player, admin;

-- Every mover within two kilometres of where somebody is standing: far enough
-- that a bus is already running when it comes into sight.
CREATE FUNCTION movers_near(p_lon double precision, p_lat double precision,
                            p_metres double precision DEFAULT 2000) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(public.one_mover(m.id) ORDER BY m.id), '[]'::jsonb)
FROM mover m
WHERE m.deleted_at IS null
  AND st_dwithin(public.mover_line(m)::geography,
                 st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography, p_metres);
$$;

GRANT EXECUTE ON FUNCTION movers_near(double precision, double precision,
                                      double precision) TO anon, player, admin;

-- Every mover on one land, for the Movers part of the Place panel.
CREATE FUNCTION movers_on(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(public.one_mover(m.id) ORDER BY m.name, m.id), '[]'::jsonb)
FROM mover m WHERE m.area_id = p_area AND m.deleted_at IS null;
$$;

GRANT EXECUTE ON FUNCTION movers_on(uuid) TO anon, player, admin;

CREATE VIEW api.mover WITH (security_invoker = true)
AS SELECT id, area_id, san, name, route_feature, speed_kmh, schedule, phase_s,
          paused, rev, deleted_at FROM public.mover;
GRANT SELECT ON api.mover TO anon, player, admin;

CREATE OR REPLACE FUNCTION api.mover_set(p_mover uuid, p_fields jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.mover_set(p_mover, p_fields)$$;
CREATE FUNCTION api.mover_drop(p_mover uuid) RETURNS boolean
LANGUAGE sql VOLATILE AS $$SELECT public.mover_drop(p_mover)$$;
CREATE FUNCTION api.one_mover(p_mover uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.one_mover(p_mover)$$;
CREATE FUNCTION api.movers_near(p_lon double precision, p_lat double precision,
                                p_metres double precision DEFAULT 2000) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.movers_near(p_lon, p_lat, p_metres)$$;
CREATE FUNCTION api.movers_on(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.movers_on(p_area)$$;

GRANT EXECUTE ON FUNCTION api.mover_set(uuid, jsonb), api.mover_drop(uuid)
TO player, admin;
GRANT EXECUTE ON FUNCTION api.one_mover(uuid),
    api.movers_near(double precision, double precision, double precision),
    api.movers_on(uuid) TO anon, player, admin;
