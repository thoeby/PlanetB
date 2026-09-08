-- 0013_world.sql — the world as one tile sees it, for the atom that has to
-- build it.
--
-- `assemble` needs every feature and instance touching a tile, which is a
-- spatial predicate no PostgREST filter expresses. It is the same predicate
-- world_snapshot() hashes, and the snapshot travels with the answer: an atom
-- can check that what it was given is what its job was built from (Invariant 2)
-- before it spends a minute compiling it.
--
-- Reads only, and only what everyone may already read (db/0003_rls.sql).

CREATE FUNCTION tile_world(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
SELECT jsonb_build_object(
    'z', z, 'x', x, 'y', y,
    'snapshot', world_snapshot(z, x, y),
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
            'lon', i.lon, 'lat', i.lat, 'h', i.h,
            'yaw', i.yaw, 'pitch', i.pitch, 'roll', i.roll,
            'scale', i.scale) ORDER BY i.id)
        FROM instance i
        WHERE i.deleted_at IS NULL
          AND st_intersects(i.geom, tile_bbox(z, x, y))), '[]'::jsonb));
$$;

GRANT EXECUTE ON FUNCTION tile_world(int, int, int) TO anon, player, admin;

CREATE FUNCTION api.tile_world(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.tile_world(z, x, y)$$;
GRANT EXECUTE ON FUNCTION api.tile_world(int, int, int) TO anon, player, admin;
