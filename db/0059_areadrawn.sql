-- 0059_areadrawn.sql — what you drew in QGIS, in the panel that says what is
-- on your land.
--
-- area_contents (db/0042) lists instances: products placed from the catalog.
-- Everything drawn in QGIS — the roads, the woods, the water, the buildings —
-- is a `feature`, and no RPC returned any, so the Your land panel answered
-- "nothing stands on it yet" to somebody who had just drawn a lake. The panel
-- was telling the truth about instances and nonsense about the land.
--
-- One row per kind, with how many and where to look, which is what a panel
-- can show without pulling every ring of every polygon over the wire.

CREATE FUNCTION area_drawn(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(k ORDER BY k ->> 'kind'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object(
        'kind', f.kind,
        'count', count(*),
        -- Somewhere inside one of them, for "go there". st_pointonsurface is
        -- what gis.area_at uses to decide which area a feature is in, so the
        -- point the panel flies to is the point the world judged it by.
        'lon', st_x(st_pointonsurface(st_collect(f.geom))),
        'lat', st_y(st_pointonsurface(st_collect(f.geom)))) AS k
    FROM feature f
    WHERE f.area_id = p_area AND f.deleted_at IS null
    GROUP BY f.kind
) q;
$$;

GRANT EXECUTE ON FUNCTION area_drawn(uuid) TO anon, player, admin;

CREATE FUNCTION api.area_drawn(area_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.area_drawn(area_id)$$;
GRANT EXECUTE ON FUNCTION api.area_drawn(uuid) TO anon, player, admin;
