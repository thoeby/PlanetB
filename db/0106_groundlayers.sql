-- 0106_groundlayers.sql — the ground is made of layers.
--
-- One coverage was the world's elevation. Now the ground may have more than
-- one source of each kind, in priority order:
--
--   dem     elevation. The `ground` row is the first; these come after it, so
--           a fine local survey can sit over a coarse national one, or the
--           other way round. The server cuts a tile from the first layer that
--           reaches it (server/splatworld/ground.py).
--   albedo  what the ground looks like from above — an orthophoto — served
--           through the same GeoServer's WMS and cut per tile as an image.
--           assemble colours every terrain vertex from it where it exists
--           (client/atoms/assemble.js).
--   shade   a light or shadow map laid over the albedo the same way: a
--           precomputed hillshade, an ambient-occlusion pass, whatever the
--           operator has. Grey; multiplies the colour.
--
-- Only an admin changes them, like the ground itself. Changing a layer does
-- not recut what is on disk: the operator deletes the store's geo/ folder and
-- presses "Render the whole ground again" (db/0104), as with a new ground.
CREATE TABLE ground_layer (
    id            serial PRIMARY KEY,
    kind          text NOT NULL CHECK (kind IN ('dem', 'albedo', 'shade')),
    geoserver_url text NOT NULL,
    layer         text NOT NULL,
    extent        geometry(Polygon, 4326) NOT NULL,
    priority      int NOT NULL DEFAULT 0,
    set_at        timestamptz NOT NULL DEFAULT now(),
    set_by        uuid
);
CREATE INDEX ground_layer_extent_idx ON ground_layer USING gist (extent);
ALTER TABLE ground_layer ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON ground_layer FOR SELECT USING (true);
GRANT SELECT ON ground_layer TO anon, player, admin;

CREATE FUNCTION set_ground_layer(p_kind text, p_url text, p_layer text,
                                 p_west double precision, p_south double precision,
                                 p_east double precision, p_north double precision,
                                 p_priority int DEFAULT 0) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    lid int;
BEGIN
    IF current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin changes the ground' USING errcode = '42501';
    END IF;
    IF p_west >= p_east OR p_south >= p_north
       OR abs(p_west) > 180 OR abs(p_east) > 180 OR abs(p_south) > 90 OR abs(p_north) > 90 THEN
        RAISE EXCEPTION 'that extent is not longitude and latitude';
    END IF;
    INSERT INTO ground_layer (kind, geoserver_url, layer, extent, priority, set_by)
    VALUES (p_kind, p_url, p_layer,
            st_makeenvelope(p_west, greatest(p_south, -85.06), p_east, least(p_north, 85.06),
                            4326),
            p_priority, current_user_id())
    RETURNING id INTO lid;
    DELETE FROM geo_tile;
    RETURN lid;
END
$$;
GRANT EXECUTE ON FUNCTION set_ground_layer(text, text, text, double precision,
    double precision, double precision, double precision, int) TO admin;

CREATE FUNCTION drop_ground_layer(p_id int) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin changes the ground' USING errcode = '42501';
    END IF;
    DELETE FROM ground_layer WHERE id = p_id;
    IF NOT FOUND THEN RETURN false; END IF;
    DELETE FROM geo_tile;
    RETURN true;
END
$$;
GRANT EXECUTE ON FUNCTION drop_ground_layer(int) TO admin;

-- db/0039's ground_view, with the layers.
CREATE OR REPLACE FUNCTION ground_view() RETURNS jsonb
LANGUAGE sql STABLE AS $$
SELECT coalesce((
    SELECT jsonb_build_object(
        'coverage', g.coverage,
        'geoserver_url', g.geoserver_url,
        'set_at', g.set_at,
        'west', st_xmin(g.extent), 'south', st_ymin(g.extent),
        'east', st_xmax(g.extent), 'north', st_ymax(g.extent),
        'centre', jsonb_build_object(
            'lon', st_x(st_centroid(g.extent)), 'lat', st_y(st_centroid(g.extent))),
        'layers', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'id', l.id, 'kind', l.kind, 'layer', l.layer,
                'geoserver_url', l.geoserver_url, 'priority', l.priority,
                'west', st_xmin(l.extent), 'south', st_ymin(l.extent),
                'east', st_xmax(l.extent), 'north', st_ymax(l.extent))
                ORDER BY l.kind, l.priority, l.id)
            FROM ground_layer l), '[]'::jsonb))
    FROM ground g), '{}'::jsonb);
$$;

CREATE FUNCTION api.set_ground_layer(kind text, url text, layer text,
                                     west double precision, south double precision,
                                     east double precision, north double precision,
                                     priority int DEFAULT 0) RETURNS int
LANGUAGE sql AS $$
SELECT public.set_ground_layer(kind, url, layer, west, south, east, north, priority)
$$;
GRANT EXECUTE ON FUNCTION api.set_ground_layer(text, text, text, double precision,
    double precision, double precision, double precision, int) TO admin;

CREATE FUNCTION api.drop_ground_layer(id int) RETURNS boolean
LANGUAGE sql AS $$SELECT public.drop_ground_layer(id)$$;
GRANT EXECUTE ON FUNCTION api.drop_ground_layer(int) TO admin;
