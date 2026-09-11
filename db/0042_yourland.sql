-- 0042_yourland.sql — your land, drawn, and what you have put on it.
--
-- TASKS-usable T5: the world outlines the ground you own and the panel lists
-- what stands on it. Both need two things the API did not offer: the area's
-- actual outline rather than its bounding box, and the instances inside one
-- area rather than near a point.

-- area_view (db/0021_build.sql) gains the outline. Everything that reads it
-- keeps working — this is one more key — and the viewer can draw the edge of
-- your land instead of a box around it.
CREATE OR REPLACE FUNCTION area_view(a area) RETURNS jsonb
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
        'lon', st_x(st_centroid(a.geom)), 'lat', st_y(st_centroid(a.geom))),
    -- Six decimals is a tenth of a metre: enough to draw an edge, and small
    -- enough that a page holding every area of a region is still a page.
    'outline', st_asgeojson(st_simplifypreservetopology(a.geom, 0.00002), 6)::jsonb);
$$;

-- What stands on one piece of land: the instances somebody placed, newest
-- first, with the name of the product each one is. Readable by anyone — the
-- world is public — and it is the panel's list in T5.
CREATE FUNCTION area_contents(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'san', i.san, 'name', a.name, 'category', a.category,
    'lon', i.lon, 'lat', i.lat, 'h', i.h, 'yaw', i.yaw, 'scale', i.scale,
    'rev', i.rev, 'thumb', a.thumb_sha256,
    'mine', i.area_id IN (SELECT ar.id FROM area ar WHERE ar.owner_id = current_user_id()))
    ORDER BY i.rev DESC, i.id), '[]'::jsonb)
FROM instance i
LEFT JOIN asset a ON a.san = i.san
WHERE i.area_id = p_area AND i.deleted_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION area_contents(uuid) TO anon, player, admin;

CREATE FUNCTION api.area_contents(area_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.area_contents(area_id)$$;
GRANT EXECUTE ON FUNCTION api.area_contents(uuid) TO anon, player, admin;
