-- 0215_oldpathsretire.sql — a stored file is read by its CID.
--
-- TASKS-live.md LV.14. The paths the store was written by (/tiles/{z}/{x}/
-- {y}/{sha}.{ext}, /assets/{sha}.{ext}) stay what a PUT names, and a GET of
-- one is sent on to /ipfs/{cid} once the world has a CID for it (db/0212) —
-- the one place a file is fetched from whoever holds it. nginx asks this
-- (infra/nginx.conf); server/ asks cid_of and answers the same way. A file
-- the world has no CID for yet is served from the store as before: a world
-- whose node is not running keeps working.
--
-- The answer is a redirect PostgREST writes itself; nothing is decided here
-- that the CID does not already say (Invariant 9).

CREATE FUNCTION file_at(p_sha256 text, p_ext text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
    c text := cid_of(p_sha256);
BEGIN
    IF c IS NULL OR p_ext !~ '^[a-z0-9]{1,8}$' THEN
        PERFORM set_config('response.status', '404', true);
        RETURN;
    END IF;
    PERFORM set_config('response.status', '302', true);
    PERFORM set_config('response.headers', json_build_array(json_build_object(
        'Location', format('/ipfs/%s?filename=%s.%s', c, p_sha256, p_ext)))::text, true);
END
$$;

GRANT EXECUTE ON FUNCTION file_at(text, text) TO anon, player, admin;

CREATE FUNCTION api.file_at(sha256 text, ext text) RETURNS void
LANGUAGE sql STABLE AS $$SELECT public.file_at(sha256, ext)$$;
GRANT EXECUTE ON FUNCTION api.file_at(text, text) TO anon, player, admin;
