-- 0021_build.sql — what build mode has to ask the server (WP4.2).
--
-- Placing an asset is an INSERT into `instance`, and row-level security already
-- decides whether it is allowed (Invariant 6): the `write_area` policy wants
-- is_area_writer(area_id). These functions only tell the tab what it is about
-- to find out anyway — which areas it may build in, and which area is under the
-- point the player is looking at — so the panel can say "you cannot build here"
-- before the database says it with a 403.
--
-- Nothing here grants anything. area_at() lists every area over a point,
-- writable or not, because "there is an area here and it is not yours" and
-- "there is no area here" are different things to a player.

-- Each of these pins its own search_path, the way db/0008_files.sql does. A
-- request arrives with whatever path PostgREST gives it, and a body that
-- reaches for `area`, `st_intersects` or a helper by bare name is one
-- deployment setting away from "function does not exist" — a failure that shows
-- up only through the API and never in psql.
CREATE FUNCTION area_view(a area) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object(
    'id', a.id,
    'owner_id', a.owner_id,
    'detail', a.detail,
    'rules', a.rules,
    'mine', a.owner_id = public.current_user_id(),
    'may_write', public.is_area_writer(a.id),
    'may_propose', public.is_area_proposer(a.id),
    'bbox', jsonb_build_object(
        'west', st_xmin(a.geom), 'south', st_ymin(a.geom),
        'east', st_xmax(a.geom), 'north', st_ymax(a.geom)),
    'centre', jsonb_build_object(
        'lon', st_x(st_centroid(a.geom)), 'lat', st_y(st_centroid(a.geom))));
$$;

-- Every area this caller may change directly. An anonymous tab gets none,
-- which is what makes the build panel hide itself.
CREATE FUNCTION my_areas() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(public.area_view(a) ORDER BY a.created_at), '[]'::jsonb)
FROM area a
WHERE public.is_area_proposer(a.id);
$$;

-- The areas over a point, coarse first. The player is standing somewhere; this
-- says who owns the ground and how deep it is compiled.
CREATE FUNCTION area_at(lon double precision, lat double precision) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(public.area_view(a) ORDER BY st_area(a.geom) DESC), '[]'::jsonb)
FROM area a
WHERE st_intersects(a.geom, st_setsrid(st_makepoint(area_at.lon, area_at.lat), 4326));
$$;

-- The tiles a point falls in, with the state the build panel puts on its badge:
-- whether the tile is dirty, what version it expects, and whether a job for
-- that version is already open. ensure_job is still what opens one.
CREATE FUNCTION tiles_at(lon double precision, lat double precision, max_z int DEFAULT 14)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'z', t.z, 'x', t.x, 'y', t.y,
    'dirty', t.dirty,
    'expected_version', t.expected_version,
    'published_version', t.published_version,
    'job_id', (SELECT j.id FROM job j
               WHERE j.z = t.z AND j.x = t.x AND j.y = t.y
                 AND j.target_version = t.expected_version AND j.state = 'open')
) ORDER BY t.z), '[]'::jsonb)
FROM tile t
WHERE t.z <= tiles_at.max_z
  AND st_intersects(public.tile_bbox(t.z, t.x, t.y),
                    st_setsrid(st_makepoint(tiles_at.lon, tiles_at.lat), 4326));
$$;

-- ------------------------------------------------------------ placed assets

-- `assemble` places an instance by loading its canonical GLB, so it needs the
-- artifact's digest and not only the SAN. ARCHITECTURE §5 always said GLB
-- hashes were among an assemble atom's inputs; until WP4.1 there were no GLBs
-- to name. Everything else about the answer is unchanged.
CREATE OR REPLACE FUNCTION tile_world(z int, x int, y int) RETURNS jsonb
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
            'sha256', a.sha256, 'canon_version', a.canon_version,
            'lon', i.lon, 'lat', i.lat, 'h', i.h,
            'yaw', i.yaw, 'pitch', i.pitch, 'roll', i.roll,
            'scale', i.scale) ORDER BY i.id)
        FROM instance i
        JOIN asset a ON a.san = i.san
        WHERE i.deleted_at IS NULL
          AND st_intersects(i.geom, tile_bbox(z, x, y))), '[]'::jsonb));
$$;

GRANT EXECUTE ON FUNCTION area_view(area), my_areas(),
    area_at(double precision, double precision),
    tiles_at(double precision, double precision, int) TO anon, player, admin;

CREATE FUNCTION api.my_areas() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.my_areas()$$;
CREATE FUNCTION api.area_at(lon double precision, lat double precision) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.area_at(lon, lat)$$;
CREATE FUNCTION api.tiles_at(lon double precision, lat double precision,
                             max_z int DEFAULT 14) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.tiles_at(lon, lat, max_z)$$;

GRANT EXECUTE ON FUNCTION api.my_areas(),
    api.area_at(double precision, double precision),
    api.tiles_at(double precision, double precision, int) TO anon, player, admin;
