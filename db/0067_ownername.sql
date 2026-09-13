-- 0067_ownername.sql — land says whose it is, by name.
--
-- SPEC §2.1 wants the owner's display name on the position line, §3.4 wants
-- "you may not build here (owner Anna)" and §3.11 wants "placed by Ben". Every
-- one of those read an eight-character slice of a uuid, because area_view()
-- carried `owner_id` and nothing else about the person.
--
-- player_name() (db/0061) is what to call somebody: their name, or the short
-- id if they have not said one. Never their email.

CREATE OR REPLACE FUNCTION area_view(a area) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object(
    'id', a.id,
    'owner_id', a.owner_id,
    'owner', public.player_name(a.owner_id),
    'detail', a.detail,
    'rules', a.rules,
    'name', coalesce(nullif(a.rules ->> 'name', ''), 'unnamed land'),
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
