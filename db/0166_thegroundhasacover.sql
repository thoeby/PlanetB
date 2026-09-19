-- 0166_thegroundhasacover.sql — the ground is made of something.
--
-- TASKS-foundation.md FND.12. db/0106 gave the ground layers: an elevation,
-- an orthophoto, a shade. A **cover** layer is a fourth, and the only one
-- nobody looks at directly: it is a class raster — forest here, rock there,
-- glacier above — published over WMS exactly as the albedo is, a raster
-- source (ESA WorldCover) already being one and a vector source (swissTLM3D,
-- OSM) being one the operator paints with a style the panel writes for them.
--
-- What a class *means* is not in the raster and is not in this file either. It
-- is the operator's mapping — this colour is `landuse=forest` — and what a
-- `landuse=forest` looks like on the ground is its symbol's `paint` layer
-- (db/0161). So the cover adds no vocabulary of its own: it says which of the
-- world's own words each patch of ground is, and the symbols say the rest.
--
-- Invariant 9 holds: nothing here reads a raster. The mapping is rows, the
-- compiler is a tab, and the server only cuts the tile (server/ground.py).

ALTER TABLE ground_layer DROP CONSTRAINT ground_layer_kind_check;
ALTER TABLE ground_layer ADD CONSTRAINT ground_layer_kind_check
    CHECK (kind IN ('dem', 'albedo', 'shade', 'cover'));

-- source value (the class code, as text) → {kind, key, value}. A value that is
-- not in here is not shown: the vocabulary grows by use, and refusing an
-- unknown class would make every new source a migration (db/0040 settled the
-- same question once already).
ALTER TABLE ground_layer ADD COLUMN class_map jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ------------------------------------------------------------ the mapping

-- A mapping reaches the world the way a symbol does (FND.8): it is saved, and
-- then somebody applies it. This is the applied one — every cover layer as it
-- stood at that moment, so a tile built against version 3 can be rebuilt
-- against version 3 whatever the panel has been doing since (Invariant 2).
CREATE TABLE cover_version (
    version    serial PRIMARY KEY,
    sources    jsonb NOT NULL,
    saved_by   uuid REFERENCES auth.user (id),
    saved_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cover_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON cover_version FOR SELECT USING (true);
GRANT SELECT ON cover_version TO anon, player, admin;

-- The cover layers as the panel has them right now, in the order the server
-- reads them (db/0106: by priority, then by id). The first one that reaches a
-- tile is the ground; the ones after it fill only where it is transparent.
CREATE FUNCTION cover_draft() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'layer', l.layer, 'url', l.geoserver_url,
    'priority', l.priority, 'class_map', l.class_map,
    'extent', jsonb_build_object(
        'west', st_xmin(l.extent), 'south', st_ymin(l.extent),
        'east', st_xmax(l.extent), 'north', st_ymax(l.extent)))
    ORDER BY l.priority, l.id), '[]'::jsonb)
FROM ground_layer l WHERE l.kind = 'cover';
$$;
GRANT EXECUTE ON FUNCTION cover_draft() TO anon, player, admin;

INSERT INTO cover_version (sources) VALUES (cover_draft());

-- What the world is built with: the sources at the version the latest applied
-- style pinned, not whatever has been mapped since.
CREATE FUNCTION pinned_cover() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce((SELECT c.sources FROM cover_version c
                 WHERE c.version = (SELECT p.cover_mapping FROM style_version p
                                    WHERE p.id = (SELECT max(id) FROM style_version))),
                '[]'::jsonb);
$$;
GRANT EXECUTE ON FUNCTION pinned_cover() TO anon, player, admin;

CREATE FUNCTION api.cover_draft() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.cover_draft()$$;
CREATE FUNCTION api.pinned_cover() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.pinned_cover()$$;
GRANT EXECUTE ON FUNCTION api.cover_draft(), api.pinned_cover()
    TO anon, player, admin;

-- Only an admin maps a class, like everything else about the ground (db/0106).
-- Saving does not move the world; applying does.
CREATE FUNCTION set_cover_map(p_id int, p_map jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM require_admin();
    IF NOT EXISTS (SELECT 1 FROM ground_layer WHERE id = p_id AND kind = 'cover') THEN
        RAISE EXCEPTION 'no cover source %', p_id USING errcode = 'PT404';
    END IF;
    UPDATE ground_layer SET class_map = coalesce(p_map, '{}'::jsonb) WHERE id = p_id;
    RETURN cover_draft();
END
$$;
GRANT EXECUTE ON FUNCTION set_cover_map(int, jsonb) TO admin;

CREATE FUNCTION api.set_cover_map(id int, map jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.set_cover_map(id, map)$$;
GRANT EXECUTE ON FUNCTION api.set_cover_map(int, jsonb) TO admin;

-- ------------------------------------------------------- applying it

-- db/0162's style_changes, counting the cover as one more thing that has been
-- saved and not applied. It is one row for the whole mapping: what changed is
-- which class means what, and that is not a symbol.
CREATE OR REPLACE FUNCTION style_changes() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
WITH pinned AS (
    SELECT coalesce((SELECT p.symbols FROM style_version p
                     WHERE p.id = (SELECT max(id) FROM style_version)),
                    '{}'::jsonb) AS at
)
SELECT coalesce(jsonb_agg(c ORDER BY c ->> 'kind', c ->> 'name'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object(
        'id', s.id, 'name', s.name, 'kind', s.kind,
        'version', s.version, 'applied', (SELECT (at ->> s.id::text)::int FROM pinned),
        'tiles', (SELECT count(*) FROM tile t
                  WHERE t.published_version > 0
                    AND EXISTS (SELECT 1 FROM feature f
                                WHERE f.deleted_at IS NULL AND f.kind = s.kind
                                  AND st_intersects(f.geom, tile_bbox(t.z, t.x, t.y))))) AS c
    FROM symbol s
    WHERE s.enabled
      AND (SELECT (at ->> s.id::text)::int FROM pinned) IS DISTINCT FROM s.version
    UNION ALL
    SELECT jsonb_build_object(
        'id', null, 'name', 'Ground cover', 'kind', 'cover',
        'version', null, 'applied', null,
        'tiles', (SELECT count(*) FROM tile t WHERE t.published_version > 0))
    WHERE cover_draft() IS DISTINCT FROM pinned_cover()
) v;
$$;

-- db/0162's apply_styles, pinning the cover mapping beside the symbols. A
-- mapping that changed is every published tile: the ground under all of them
-- is what it is about.
CREATE OR REPLACE FUNCTION apply_styles(p_note text DEFAULT null) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    changed jsonb := style_changes();
    cover   boolean := cover_draft() IS DISTINCT FROM pinned_cover();
    kinds   text [];
    cver    int;
    sid     int;
    t       record;
    jid     bigint;
    n       int := 0;
BEGIN
    PERFORM require_admin();
    IF jsonb_array_length(changed) = 0 THEN
        RETURN jsonb_build_object('style_version', (SELECT max(id) FROM style_version),
            'symbols', 0, 'tiles', 0);
    END IF;
    SELECT array_agg(DISTINCT c ->> 'kind') INTO kinds
    FROM jsonb_array_elements(changed) c;

    IF cover THEN
        INSERT INTO cover_version (sources, saved_by)
        VALUES (cover_draft(), current_user_id()) RETURNING version INTO cver;
    ELSE
        SELECT p.cover_mapping INTO cver FROM style_version p
        WHERE p.id = (SELECT max(id) FROM style_version);
    END IF;

    INSERT INTO style_version (symbols, cover_mapping, note, applied_by)
    SELECT coalesce(jsonb_object_agg(s.id::text, s.version), '{}'::jsonb),
        coalesce(cver, 1), p_note, current_user_id()
    FROM symbol s WHERE s.enabled
    RETURNING id INTO sid;

    -- Invariant 4: mark dirty, then ask for the job. A changed mapping is
    -- every published tile; a changed symbol is the tiles its kind is in.
    PERFORM set_config('splatworld.rebuild', '1', true);
    FOR t IN
        WITH styled AS MATERIALIZED (SELECT * FROM tiles_for_styles(kinds)),
        covered AS MATERIALIZED (
            SELECT ti.z::int AS z, ti.x, ti.y FROM tile ti
            WHERE cover AND ti.published_version > 0),
        inflight AS MATERIALIZED (
            SELECT j.z::int AS z, j.x, j.y FROM job j
            INNER JOIN tile ti ON ti.z = j.z AND ti.x = j.x AND ti.y = j.y
            WHERE j.state = 'open' AND j.target_version = ti.expected_version)
        SELECT z, x, y FROM styled
        UNION
        SELECT z, x, y FROM covered
        UNION
        SELECT z, x, y FROM inflight
    LOOP
        UPDATE tile SET dirty = true, expected_version = expected_version + 1
        WHERE tile.z = t.z AND tile.x = t.x AND tile.y = t.y;
        jid := ensure_job(t.z, t.x, t.y);
        UPDATE job SET reason = 'style update' WHERE id = jid;
        n := n + 1;
    END LOOP;
    PERFORM set_config('splatworld.rebuild', '', true);

    RETURN jsonb_build_object('style_version', sid, 'cover_mapping', cver,
        'symbols', jsonb_array_length(changed), 'tiles', n);
END
$$;

-- ------------------------------------------------------------ the compiler

-- db/0163's tile_world, with the applied cover mapping beside the symbols. The
-- raster itself the tab fetches from the store, as it fetches the elevation.
CREATE OR REPLACE FUNCTION tile_world(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
SELECT jsonb_build_object(
    'z', z, 'x', x, 'y', y,
    'snapshot', world_snapshot(z, x, y),
    'symbols', pinned_symbols(),
    'symbol_files', symbol_files(),
    'height_edits', height_edits(z, x, y),
    'cover', pinned_cover(),
    'features', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'id', f.id, 'kind', f.kind, 'rev', f.rev, 'props', f.props,
            'geom', st_asgeojson(f.geom, 12)::jsonb) ORDER BY f.id)
        FROM feature f
        WHERE f.deleted_at IS NULL
          AND st_intersects(f.geom, tile_bbox(z, x, y))), '[]'::jsonb),
    'instances', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'id', i.id, 'san', i.san, 'rev', i.rev, 'props', i.props,
            'sha256', a.sha256, 'canon_version', a.canon_version, 'parts', a.parts,
            'lon', i.lon, 'lat', i.lat, 'h', i.h,
            'yaw', i.yaw, 'pitch', i.pitch, 'roll', i.roll,
            'scale', i.scale) ORDER BY i.id)
        FROM instance i
        JOIN asset a ON a.san = i.san
        WHERE i.deleted_at IS NULL
          AND st_intersects(i.geom, tile_bbox(z, x, y))), '[]'::jsonb));
$$;
