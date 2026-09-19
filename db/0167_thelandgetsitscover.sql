-- 0167_thelandgetsitscover.sql — a land's ground is its own.
--
-- TASKS-foundation.md FND.13. The cover (db/0166) is the operator's: a raster
-- of classes over the whole world, mapped onto the world's own words. Land
-- that belongs to somebody is different. What is on it is theirs to draw, to
-- cut a clearing out of and to send for approval like anything else they
-- build, so when a land is assigned the cover inside it stops being the
-- operator's raster and becomes the landholder's shapes.
--
-- The tracing is a tab's (Invariant 9) — the assigning admin's, in
-- client/lib/gen/trace.js. This is where the shapes land, and what the
-- compiler is told so that it leaves that ground alone.

-- The lands a tile touches, with their outlines. The compiler takes the cover
-- away inside each of them and draws what is on them instead; a tile with no
-- land on it is unaffected, which is most of the world.
CREATE FUNCTION tile_lands(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT SET search_path = public AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'geom', st_asgeojson(a.geom, 12)::jsonb) ORDER BY a.id), '[]'::jsonb)
FROM area a
WHERE st_intersects(a.geom, tile_bbox(z, x, y));
$$;
GRANT EXECUTE ON FUNCTION tile_lands(int, int, int) TO anon, player, admin;

-- Invariant 2: which ground is somebody's is part of what a tile is built
-- from. A land assigned over a tile changes what the compiler draws there, so
-- an atom made before it cannot publish after it.
CREATE OR REPLACE FUNCTION world_snapshot(z int, x int, y int) RETURNS text
LANGUAGE sql STABLE STRICT SET search_path = public AS $$
SELECT encode(public.digest(
    coalesce(string_agg(sig, ',' ORDER BY sig), '') || E'\nstyle:'
    || coalesce((SELECT max(id) FROM style_version), 0)::text
    || E'\nground:' || coalesce((
        SELECT string_agg(e ->> 'sha256', ',' ORDER BY e ->> 'area_id')
        FROM jsonb_array_elements(height_edits(z, x, y)) e), '')
    || E'\nlands:' || coalesce((
        SELECT string_agg(l ->> 'id', ',' ORDER BY l ->> 'id')
        FROM jsonb_array_elements(tile_lands(z, x, y)) l), ''),
    'sha256'), 'hex')
FROM (
    SELECT f.id::text || ':' || f.rev::text AS sig
    FROM feature f
    WHERE f.deleted_at IS NULL
      AND st_intersects(f.geom, tile_bbox(z, x, y))
    UNION ALL
    SELECT i.id::text || ':' || i.rev::text
    FROM instance i
    WHERE i.deleted_at IS NULL
      AND st_intersects(i.geom, tile_bbox(z, x, y))
) s;
$$;

-- db/0166's tile_world, carrying the lands with the rest of it.
CREATE OR REPLACE FUNCTION tile_world(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT SET search_path = public AS $$
SELECT jsonb_build_object(
    'z', z, 'x', x, 'y', y,
    'snapshot', world_snapshot(z, x, y),
    'symbols', pinned_symbols(),
    'symbol_files', symbol_files(),
    'height_edits', height_edits(z, x, y),
    'cover', pinned_cover(),
    'lands', tile_lands(z, x, y),
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

-- ------------------------------------------------------- copying the cover

-- The shapes the assigning admin traced, written as the land's own features.
--
-- Invariant 6: the admin is not the landholder and never becomes one. This is
-- the one thing they do on the land — hand over what was already there — and
-- it happens once, at assignment, before anybody has built anything. A land
-- that already has shapes on it is left alone.
CREATE FUNCTION copy_cover(p_area uuid, p_shapes jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    s    jsonb;
    kept int := 0;
BEGIN
    PERFORM require_admin();
    IF NOT EXISTS (SELECT 1 FROM area WHERE id = p_area) THEN
        RAISE EXCEPTION 'no land %', p_area USING errcode = 'PT404';
    END IF;
    IF EXISTS (SELECT 1 FROM feature f
               WHERE f.area_id = p_area AND f.props ? 'from_cover'
                 AND f.deleted_at IS NULL) THEN
        RETURN jsonb_build_object('copied', 0, 'already', true);
    END IF;
    FOR s IN SELECT * FROM jsonb_array_elements(coalesce(p_shapes, '[]'::jsonb))
    LOOP
        INSERT INTO feature (area_id, kind, geom, props)
        VALUES (p_area, s ->> 'kind',
            st_force3d(st_setsrid(st_geomfromgeojson(s -> 'geom'), world_srid())),
            coalesce(s -> 'props', '{}'::jsonb) || jsonb_build_object('from_cover', true));
        kept := kept + 1;
    END LOOP;
    RETURN jsonb_build_object('copied', kept, 'already', false);
END
$$;
GRANT EXECUTE ON FUNCTION copy_cover(uuid, jsonb) TO admin;

CREATE FUNCTION api.copy_cover(area uuid, shapes jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.copy_cover(area, shapes)$$;
GRANT EXECUTE ON FUNCTION api.copy_cover(uuid, jsonb) TO admin;

-- One land, as every panel reads one (db/0067's area_view). The assigning
-- admin needs the outline and the box of the land they have just made, and
-- `my_areas` is about lands you may build on, which this is not one of.
CREATE FUNCTION one_land(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT public.area_view(a) FROM area a WHERE a.id = p_id;
$$;
GRANT EXECUTE ON FUNCTION one_land(uuid) TO anon, player, admin;

CREATE FUNCTION api.one_land(id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.one_land(id)$$;
GRANT EXECUTE ON FUNCTION api.one_land(uuid) TO anon, player, admin;
