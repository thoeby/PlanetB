-- 0065_playerroles.sql — QGIS draws as you, not as one operator.
--
-- REFACTOR-direct-pg.md S2. Until now QGIS reached the world over WFS-T
-- through GeoServer, which connects as one database login with BYPASSRLS: what
-- anybody drew belonged to whoever gis.default_owner() guessed, and row-level
-- security — the thing that decides everything in the browser — did not apply
-- at all. Every drawing bug since db/0028 has been a consequence or a
-- workaround of that.
--
-- A player gets a LOGIN role of their own, `p_<12 hex of their id>`, with the
-- `player` role granted to it. Every policy already asks current_user_id();
-- this teaches that function to answer for a session that arrived with a
-- password instead of a token, and nothing else changes.

ALTER TABLE auth.user ADD COLUMN db_role text UNIQUE;

-- Who is asking, whether they came with a token or with a password.
--
-- The lookup is its own SECURITY DEFINER function, taking the role name as an
-- argument, because inside a SECURITY DEFINER function `current_user` is the
-- function's owner: a definer current_user_id() would ask who postgres is and
-- answer nothing at all.
-- In `public`, not in `auth`: the auth schema is nobody's to enter
-- (db/0002_auth.sql revokes it from PUBLIC), and these two answer one question
-- each about a role that is already connected.
CREATE FUNCTION id_of_role(who name) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
SELECT u.id FROM auth.user u WHERE u.db_role = who::text;
$$;

CREATE FUNCTION role_of_role(who name) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
SELECT u.role FROM auth.user u WHERE u.db_role = who::text;
$$;

REVOKE ALL ON FUNCTION id_of_role(name), role_of_role(name) FROM PUBLIC;
-- `geoserver` too, until S5 takes that role away: every role that writes asks
-- current_user_id(), and it now asks these.
GRANT EXECUTE ON FUNCTION id_of_role(name), role_of_role(name)
    TO anon, player, admin, geoserver;

-- The token is looked at first and the table is only read when there is no
-- token: this is called once per row by every policy in the schema, and CASE
-- does not evaluate the branch it does not take.
--
-- nullif on the text before the cast, not after it: an empty claims setting is
-- not JSON, and ''::json is an error rather than a null.
CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
SELECT CASE
    WHEN nullif(nullif(current_setting('request.jwt.claims', true), '')::json
                ->> 'sub', '') IS NOT null
        THEN (nullif(current_setting('request.jwt.claims', true), '')::json
              ->> 'sub')::uuid
    WHEN current_user LIKE 'p\_%' THEN id_of_role(current_user)
END;
$$;

CREATE OR REPLACE FUNCTION current_user_role() RETURNS text
LANGUAGE sql STABLE AS $$
SELECT CASE
    WHEN nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role'
         IS NOT null
        THEN nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role'
    WHEN current_user LIKE 'p\_%'
        THEN coalesce(role_of_role(current_user), 'anon')
    ELSE 'anon'
END;
$$;

-- The schema QGIS draws in is the player's to use. Which rows they may touch
-- is row-level security's answer, exactly as it is in the browser
-- (Invariant 6) — these grants only say "the door is not locked to players".
GRANT USAGE ON SCHEMA gis TO player;
GRANT SELECT ON ALL TABLES IN SCHEMA gis TO player;
GRANT SELECT, INSERT, UPDATE, DELETE ON gis.instance TO player;
ALTER DEFAULT PRIVILEGES IN SCHEMA gis
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO player;

-- Land is not drawn, it is assigned (SPEC §3.2), so `Your land` is a layer to
-- see your boundary on and not one to edit.
REVOKE INSERT, UPDATE, DELETE ON gis.area FROM player;

-- The per-kind views (db/0041_gisforms.sql regenerates them whenever an admin
-- changes the vocabulary) are the ones people actually draw on.
DO $$
DECLARE
    v text;
BEGIN
    FOR v IN SELECT table_name FROM information_schema.views
             WHERE table_schema = 'gis' AND table_name LIKE 'f\_%'
    LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON gis.%I TO player', v);
    END LOOP;
END
$$;

-- ------------------------------------------------------------- the role itself

-- The whole id, not a prefix of it: a role name is an identity, and two
-- players whose ids happen to start alike must not be handed the same login.
-- 34 characters, well inside Postgres's 63.
CREATE FUNCTION auth.role_name(uid uuid) RETURNS text
LANGUAGE sql IMMUTABLE AS $$SELECT 'p_' || replace(uid::text, '-', '')$$;

-- Makes the player's own login if it has none, sets its password, and returns
-- the name. SECURITY DEFINER because creating a role is the schema owner's
-- work; which player it is made for is the caller's identity, never an
-- argument.
CREATE FUNCTION ensure_db_role(pw text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    uid       uuid := current_user_id();
    who       auth.user;
    role_name text;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'sign in first' USING errcode = '28000';
    END IF;
    SELECT * INTO who FROM auth.user WHERE id = uid;
    role_name := auth.role_name(uid);
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', role_name, pw);
    ELSE
        EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', role_name, pw);
    END IF;
    EXECUTE format('GRANT player TO %I', role_name);
    IF who.role = 'admin' THEN
        EXECUTE format('GRANT admin TO %I', role_name);
    END IF;
    UPDATE auth.user u SET db_role = role_name WHERE u.id = uid;
    RETURN role_name;
END
$$;

-- What QGIS needs in a connection dialog. The password is generated here and
-- shown once: it is never stored in the world, only in Postgres.
CREATE FUNCTION qgis_credentials(rotate boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    uid       uuid := current_user_id();
    role_name text;
    pw        text;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'sign in first' USING errcode = '28000';
    END IF;
    SELECT u.db_role INTO role_name FROM auth.user u WHERE u.id = uid;
    IF role_name IS NOT null AND NOT rotate THEN
        RETURN jsonb_build_object('role', role_name, 'password', null,
                                  'dbname', current_database());
    END IF;
    pw := encode(public.gen_random_bytes(18), 'hex');
    role_name := ensure_db_role(pw);
    RETURN jsonb_build_object('role', role_name, 'password', pw,
                              'dbname', current_database());
END
$$;

REVOKE ALL ON FUNCTION ensure_db_role(text), qgis_credentials(boolean),
    auth.role_name(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qgis_credentials(boolean) TO player, admin;

CREATE FUNCTION api.qgis_credentials(rotate boolean DEFAULT false) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.qgis_credentials(rotate)$$;
REVOKE ALL ON FUNCTION api.qgis_credentials(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.qgis_credentials(boolean) TO player, admin;

-- Whose land it becomes when somebody draws is no longer a guess: it is
-- whoever is connected (db/0058_drawnbyoperator.sql existed only because
-- GeoServer carried no person).
CREATE OR REPLACE FUNCTION gis.default_owner() RETURNS uuid
LANGUAGE sql STABLE SET search_path = public AS $$SELECT public.current_user_id()$$;

-- What somebody drawing in QGIS is told when they draw where they have no
-- land. "Draw an area first" was true when land was drawn; since SPEC §3.2 it
-- is assigned, and the sentence has to say what to do about that instead.
CREATE OR REPLACE FUNCTION default_area() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF new.area_id IS NOT null THEN
        RETURN new;
    END IF;
    IF tg_table_name = 'instance' THEN
        new.area_id := gis.area_at(st_setsrid(st_makepoint(new.lon, new.lat),
                                              world_srid()));
    ELSE
        new.area_id := gis.area_at(new.geom);
    END IF;
    IF new.area_id IS null THEN
        RAISE EXCEPTION 'that is not your land — nobody owns the ground there.'
                        ' Ask an admin for land, or draw inside the land you'
                        ' already have'
            USING errcode = '42501';
    END IF;
    -- Row-level security would refuse this anyway, in the one sentence
    -- Postgres has for it ("new row violates row-level security policy"), and
    -- that is what QGIS would show somebody who drew over the fence. Say whose
    -- land it is instead; the policy still decides (Invariant 6).
    IF NOT is_area_writer(new.area_id) THEN
        RAISE EXCEPTION 'that is not your land — % owns it. Ask them for a'
                        ' build grant', (SELECT player_name(a.owner_id)
                                         FROM area a WHERE a.id = new.area_id)
            USING errcode = '42501';
    END IF;
    RETURN new;
END;
$$;
