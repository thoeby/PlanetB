-- 0154_thegroundcanbecutagain.sql — the elevation behind the coverage changed,
-- so cut the world again.
--
-- The ground is cut one tile at a time and kept as a file (TASKS-usable T1),
-- and nothing about the coverage's *name* changes when an operator publishes a
-- new survey under it. So the store went on serving the tiles it cut from the
-- old one, the browser went on reading the copies it had — they are served
-- immutable — and every map of the world showed ground that no longer exists.
-- Deleting the store's geo/ folder by hand was the only way out, which is what
-- the setup panel told people to do.
--
-- This is the same act, said in the world: forget every cut. The rows that say
-- which tile is cut from what go (db/0039 geo_tile), and the ground's own
-- `set_at` moves, which is what the store compares a cut file's age against
-- (server/splatworld/ground.py stale) and what a browser hangs its copies on
-- (client/lib/geo.js `v`). The tiles already compiled are not touched: their
-- elevation is pinned by hash (Invariant 2), and rendering them again is
-- `compile_ground()`, a separate decision with a button of its own.
CREATE FUNCTION recut_ground() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid uuid := current_user_id();
    n   int := 0;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    IF current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin cuts the world again' USING errcode = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ground) THEN
        RAISE EXCEPTION 'there is no ground to cut';
    END IF;
    SELECT count(*) INTO n FROM geo_tile;
    DELETE FROM geo_tile;
    UPDATE ground SET set_at = now();
    RETURN jsonb_build_object('forgotten', n,
        'cut_at', (SELECT set_at FROM ground));
END
$$;

REVOKE ALL ON FUNCTION recut_ground() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recut_ground() TO admin;

CREATE FUNCTION api.recut_ground() RETURNS jsonb
LANGUAGE sql VOLATILE AS $$
SELECT public.recut_ground()
$$;

GRANT EXECUTE ON FUNCTION api.recut_ground() TO admin;
