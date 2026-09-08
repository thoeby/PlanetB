-- 0012_work.sql — the one question the work panel asks that the REST surface
-- cannot: which of my tiles need compiling?
--
-- "Mine" is a spatial test against every area I may write, which no PostgREST
-- filter can express, and the client cannot answer it either without pulling
-- every area's geometry. It reads and decides nothing else: no state changes
-- here, and SECURITY INVOKER keeps the caller's own row-level security over
-- `tile` and `area` (Invariant 6).

CREATE FUNCTION my_dirty_tiles(p_limit int DEFAULT 50)
RETURNS TABLE (
    z                smallint,
    x                int,
    y                int,
    expected_version bigint,
    published_version bigint,
    job_id           bigint
)
LANGUAGE sql STABLE AS $$
SELECT
    t.z, t.x, t.y, t.expected_version, t.published_version,
    (SELECT j.id FROM job j
     WHERE j.z = t.z AND j.x = t.x AND j.y = t.y
       AND j.state = 'open' AND j.target_version = t.expected_version)
FROM tile t
WHERE t.dirty
  AND EXISTS (
      SELECT 1 FROM area a
      WHERE is_area_writer(a.id)
        AND st_intersects(a.geom, tile_bbox(t.z, t.x, t.y)))
ORDER BY t.z DESC, t.x, t.y
LIMIT greatest(p_limit, 0);
$$;

GRANT EXECUTE ON FUNCTION my_dirty_tiles(int) TO player, admin;

CREATE FUNCTION api.my_dirty_tiles(p_limit int DEFAULT 50)
RETURNS TABLE (
    z                smallint,
    x                int,
    y                int,
    expected_version bigint,
    published_version bigint,
    job_id           bigint
)
LANGUAGE sql STABLE AS $$SELECT * FROM public.my_dirty_tiles(p_limit)$$;

GRANT EXECUTE ON FUNCTION api.my_dirty_tiles(int) TO player, admin;
