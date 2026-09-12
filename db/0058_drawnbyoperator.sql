-- 0058_drawnbyoperator.sql — what you draw belongs to you, not to the oldest
-- row in auth.user.
--
-- GeoServer connects as the `geoserver` role, which carries no person, so
-- db/0028 had to answer "who owns this?" without being told, and chose the
-- oldest admin. On a fresh single-operator install that is the operator and
-- the choice is invisible. The moment a second admin exists — a seed, a test
-- fixture, a colleague — everything drawn in QGIS silently belongs to whoever
-- registered first, and the operator's own Your land panel is empty with no
-- error anywhere. That is what it looked like:
--
--     area.owner_id -> w0@torture.test
--     my_areas() -> []
--
-- There is a better answer already in the database. `ground.set_by` is the
-- account that pointed this world at its coverage in Setup — the operator, by
-- definition, because only an admin may move the world and the first one to
-- do it is whoever installed it. Land drawn through GeoServer belongs to them.
-- The oldest admin stays as the fallback for a world whose ground is not set
-- yet, which is the only case where nothing better is known.

CREATE OR REPLACE FUNCTION gis.default_owner() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
SELECT coalesce(
    -- The operator: whoever set this world's ground in Setup.
    (SELECT g.set_by FROM ground g WHERE g.set_by IS NOT null LIMIT 1),
    -- No ground yet: the oldest admin, as db/0028 had it.
    (SELECT u.id FROM auth.user u WHERE u.role = 'admin'
     ORDER BY u.created_at, u.id LIMIT 1));
$$;

GRANT EXECUTE ON FUNCTION gis.default_owner() TO geoserver;

-- Who that is, so the Setup panel can say it and nobody has to find out by
-- drawing something and losing it. Readable by anyone signed in: it is the
-- name on the world, not a secret.
CREATE FUNCTION drawing_as() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
SELECT jsonb_build_object(
    'id', u.id,
    'email', u.email,
    -- Told from the ground, or guessed from the age of the account, which is
    -- worth saying out loud because it is a guess.
    'from_ground', EXISTS (SELECT 1 FROM ground g WHERE g.set_by = u.id))
FROM auth.user u WHERE u.id = gis.default_owner();
$$;

GRANT EXECUTE ON FUNCTION drawing_as() TO anon, player, admin;

CREATE FUNCTION api.drawing_as() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.drawing_as()$$;
GRANT EXECUTE ON FUNCTION api.drawing_as() TO anon, player, admin;
