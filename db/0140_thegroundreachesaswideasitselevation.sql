-- 0140_thegroundreachesaswideasitselevation.sql — the world is as wide as the
-- elevation it is cut from, all of it.
--
-- The store cuts a DEM tile from the `ground` row and then from every
-- `ground_layer` of kind 'dem', each with its own extent, taking the first
-- that reaches the tile (server/splatworld/ground.py, layers_of + covers,
-- db/0106). So adding a layer widened what the store will serve.
--
-- It widened nothing else. `compile_ground` made its tiles and its jobs from
-- `ground.extent` alone, and `refuse_outside_ground` measured land against the
-- same one box. A world whose elevation was extended by a layer therefore had
-- ground the viewer could see — the minimap reads /geo/dem straight from the
-- store — and no job, no tile and no buildable land anywhere in it. "Render
-- the whole ground" made hundreds of jobs inside the first coverage and none
-- five kilometres away where the player's land actually was.
--
-- `ground_reach()` is the union: the base coverage and every dem layer. It is
-- what the world means by its own ground from here on, so adding elevation
-- extends the world and the next "render the whole ground" compiles it.
--
-- Land is still admitted on intersection rather than containment. In a real
-- install the elevation reaches further than anyone may walk, so an edge tile
-- that is half outside is the ordinary case and not a mistake.
--
-- Invariant 9 holds: this reads rows the operator wrote. Nothing is fetched.
CREATE FUNCTION ground_reach() RETURNS geometry
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT st_union(box) FROM (
    SELECT extent AS box FROM ground
    UNION ALL
    SELECT extent FROM ground_layer WHERE kind = 'dem'
) AS every_source;
$$;

REVOKE ALL ON FUNCTION ground_reach() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ground_reach() TO anon, player, admin;

-- db/0062's refuse_outside_ground, measuring against every source of ground
-- rather than the first one.
CREATE OR REPLACE FUNCTION refuse_outside_ground(g geometry, what text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    box geometry;
BEGIN
    -- A world with no ground yet refuses nothing: there is nothing to be
    -- outside of, and the operator has not chosen it (SPEC §3.1).
    box := ground_reach();
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

-- db/0109's compile_ground, over every source of elevation the world has.
CREATE OR REPLACE FUNCTION compile_ground() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    reach geometry := ground_reach();
    at    record;
    n     int := 0;
BEGIN
    IF reach IS NULL THEN
        RETURN 0;
    END IF;
    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT tg.z, tg.x, tg.y, true, 1 FROM tiles_for_geom(reach, 6, 14) AS tg
    ORDER BY tg.z, tg.x, tg.y
    ON CONFLICT (z, x, y) DO UPDATE
    SET dirty = true, expected_version = tile.expected_version + 1;
    PERFORM supersede_jobs(reach);
    PERFORM set_config('splatworld.rebuild', '1', true);
    FOR at IN SELECT tile.x, tile.y FROM tile
              WHERE tile.z = 14 AND st_intersects(tile_bbox(14, tile.x, tile.y), reach)
              ORDER BY tile.x, tile.y LOOP
        IF job_outcome(ensure_job(14, at.x, at.y)) = 'open' THEN
            n := n + 1;
        END IF;
    END LOOP;
    PERFORM set_config('splatworld.rebuild', '', true);
    RETURN n;
END
$$;

-- db/0106's ground_view, saying how far the world reaches as well as where its
-- first coverage is. `west`…`north` are what the setup panel and the viewer
-- read as the world's bounds, so they are the union; `coverage_*` keeps the
-- base coverage's own box, which is the thing an operator recognises.
CREATE OR REPLACE FUNCTION ground_view() RETURNS jsonb
LANGUAGE sql STABLE AS $$
SELECT coalesce((
    SELECT jsonb_build_object(
        'coverage', g.coverage,
        'geoserver_url', g.geoserver_url,
        'set_at', g.set_at,
        'west', st_xmin(r.box), 'south', st_ymin(r.box),
        'east', st_xmax(r.box), 'north', st_ymax(r.box),
        'coverage_west', st_xmin(g.extent), 'coverage_south', st_ymin(g.extent),
        'coverage_east', st_xmax(g.extent), 'coverage_north', st_ymax(g.extent),
        'centre', jsonb_build_object(
            'lon', st_x(st_centroid(r.box)), 'lat', st_y(st_centroid(r.box))),
        'layers', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'id', l.id, 'kind', l.kind, 'layer', l.layer,
                'geoserver_url', l.geoserver_url, 'priority', l.priority,
                'west', st_xmin(l.extent), 'south', st_ymin(l.extent),
                'east', st_xmax(l.extent), 'north', st_ymax(l.extent))
                ORDER BY l.kind, l.priority, l.id)
            FROM ground_layer l), '[]'::jsonb))
    FROM ground g, LATERAL (SELECT ground_reach() AS box) AS r), '{}'::jsonb);
$$;
