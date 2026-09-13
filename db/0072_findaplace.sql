-- 0072_findaplace.sql — finding a place by name (SPEC §2.3, §3.8).
--
-- The map's search box: "land name, player name, product name -> results on the
-- map". Land and the person who owns it are what a link is usually about, so
-- that is what this answers; a product is in the catalog's own search already.
--
-- Public, like every other question about the world (db/0003_rls.sql): who owns
-- what ground is not a secret, and a visitor who has not signed in still has to
-- be able to find the place somebody told them about.
CREATE FUNCTION find_places(p_q text, p_limit int DEFAULT 8) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(row ORDER BY row ->> 'name'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object(
        'id', a.id,
        'name', coalesce(a.rules ->> 'name', 'unnamed land'),
        'owner', player_name(a.owner_id),
        'lon', st_x(st_pointonsurface(a.geom)),
        'lat', st_y(st_pointonsurface(a.geom))) AS row
    FROM area a
    WHERE length(btrim(coalesce(p_q, ''))) > 0
      AND (coalesce(a.rules ->> 'name', '') ILIKE '%' || btrim(p_q) || '%'
           OR coalesce(player_name(a.owner_id), '') ILIKE '%' || btrim(p_q) || '%')
    LIMIT greatest(p_limit, 0)
) q;
$$;

CREATE FUNCTION api.find_places(q text, "limit" int DEFAULT 8) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.find_places(q, "limit")$$;

REVOKE ALL ON FUNCTION find_places(text, int), api.find_places(text, int) FROM public;
GRANT EXECUTE ON FUNCTION find_places(text, int), api.find_places(text, int)
TO anon, player, admin;
