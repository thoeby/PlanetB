-- 0062_insideground.sql — nothing is drawn where the world is not.
--
-- REFACTOR-direct-pg.md S1. A polygon whose axes are the wrong way round is
-- stored happily today and fails hours later, in a compile, as "outside the
-- world's coverage" — 5 600 km from where somebody drew it. The refusal
-- belongs at the write, in words, next to the thing that caused it (SPEC
-- §3.12), and it belongs here rather than in any one client: the browser, the
-- QGIS project and the importer all write through the database.

-- SECURITY DEFINER because this is asked on every write, by every role that
-- can make one — including the one QGIS draws as, which has no business
-- reading the ground table. Where the world reaches is public: api.ground()
-- already tells anon.
CREATE FUNCTION inside_ground(g geometry) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT EXISTS (SELECT 1 FROM ground WHERE st_intersects(extent, g));
$$;

GRANT EXECUTE ON FUNCTION inside_ground(geometry) TO anon, player, admin;

-- Raises, or returns. `what` names the thing on the screen: "this land", "the
-- forest you drew" — so the sentence reads as an answer to what was just done.
CREATE FUNCTION refuse_outside_ground(g geometry, what text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    box geometry;
BEGIN
    -- A world with no ground yet refuses nothing: there is nothing to be
    -- outside of, and the operator has not chosen it (SPEC §3.1).
    SELECT extent INTO box FROM ground LIMIT 1;
    IF box IS NULL OR st_intersects(box, g) THEN
        RETURN;
    END IF;
    IF st_intersects(box, st_flipcoordinates(g)) THEN
        RAISE EXCEPTION '% has longitude and latitude swapped — the world is'
                        ' at % E, % N',
            what,
            round(st_xmin(box)::numeric, 4) || '..' || round(st_xmax(box)::numeric, 4),
            round(st_ymin(box)::numeric, 4) || '..' || round(st_ymax(box)::numeric, 4)
            USING errcode = '23514';
    END IF;
    RAISE EXCEPTION '% is outside the world''s ground, which reaches % E, % N',
        what,
        round(st_xmin(box)::numeric, 4) || '..' || round(st_xmax(box)::numeric, 4),
        round(st_ymin(box)::numeric, 4) || '..' || round(st_ymax(box)::numeric, 4)
        USING errcode = '23514';
END
$$;

GRANT EXECUTE ON FUNCTION refuse_outside_ground(geometry, text) TO anon, player, admin;

-- The three ways a geometry gets into this world. Each keeps everything it
-- already checked; this is one line before the insert.
CREATE OR REPLACE FUNCTION create_area(p_geojson jsonb, p_detail int DEFAULT 0,
                                       p_name text DEFAULT '') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid uuid := current_user_id();
    g   geometry;
    aid uuid;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    BEGIN
        g := st_setsrid(st_geomfromgeojson(p_geojson), world_srid());
    EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'that is not GeoJSON geometry: %', sqlerrm;
    END;
    IF st_geometrytype(g) <> 'ST_Polygon' THEN
        RAISE EXCEPTION 'an area is one polygon, not %', st_geometrytype(g);
    END IF;
    IF NOT st_isvalid(g) THEN
        RAISE EXCEPTION 'the outline is not valid: %', st_isvalidreason(g);
    END IF;
    PERFORM refuse_outside_ground(g, coalesce(nullif(p_name, ''), 'this land'));

    -- Overlapping someone else's area is deliberately allowed: 1 037 system
    -- areas cover Switzerland (docs/seed-ch.md), so refusing overlap would
    -- refuse every area a player could draw there. What overlap grants is
    -- ensure_job over those tiles — volunteered browser compute, not a write
    -- on anybody's features, which is_area_writer still decides per area.
    INSERT INTO area (geom, owner_id, detail, rules)
    VALUES (g, uid, p_detail,
            jsonb_build_object('required_approvals', 1)
            || CASE WHEN coalesce(p_name, '') = '' THEN '{}'::jsonb
                    ELSE jsonb_build_object('name', p_name) END)
    RETURNING area.id INTO aid;
    RETURN aid;
END
$$;

-- A feature is normalised to lon/lat first (0053), so this sees the geometry
-- as it will be stored.
CREATE OR REPLACE FUNCTION feature_force_3d() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    new.geom := st_force3d(as_lonlat(new.geom));
    PERFORM refuse_outside_ground(new.geom, 'the ' || new.kind || ' you drew');
    RETURN new;
END;
$$;

-- Every write asks these, so every writing role may; PUBLIC may not, because
-- PUBLIC is not a role that writes.
REVOKE ALL ON FUNCTION inside_ground(geometry),
    refuse_outside_ground(geometry, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inside_ground(geometry),
    refuse_outside_ground(geometry, text) TO anon, player, admin, geoserver;
