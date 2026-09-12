-- 0061_playername.sql — what to call a player.
--
-- SPEC §3.1: signing up is "email + password → your name". Until now an
-- account had only an email, so the page said `a3f19c2b` where the spec says
-- "owner Anna" (§3.4), "by Ben" (§3.7) and "placed by Ben" (§3.11). An eight
-- character slice of a uuid is not a person.
--
-- The name is public: it is how the world attributes land, objects and
-- renders. The email is not, and stays where it was.

ALTER TABLE auth.user ADD COLUMN name text
    CHECK (name IS null OR (length(btrim(name)) BETWEEN 1 AND 40));

-- Who I am, for the page that has my token: my own email is mine to see.
CREATE FUNCTION me() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
SELECT jsonb_build_object('id', u.id, 'email', u.email, 'name', u.name,
                          'role', u.role)
FROM auth.user u WHERE u.id = current_user_id();
$$;

GRANT EXECUTE ON FUNCTION me() TO player, admin;

-- Mine to set, nobody else's. SECURITY DEFINER because auth.user is not a
-- table any client role may write (Invariant 6): the row is chosen by the
-- token, never by an argument.
CREATE FUNCTION set_my_name(new_name text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    who uuid := current_user_id();
BEGIN
    IF who IS null THEN
        RAISE EXCEPTION 'sign in before you can be called anything'
            USING ERRCODE = '42501';
    END IF;
    IF btrim(coalesce(new_name, '')) = '' THEN
        RAISE EXCEPTION 'a name is what the world calls you — type one'
            USING ERRCODE = '23514';
    END IF;
    UPDATE auth.user SET name = btrim(new_name) WHERE id = who;
    RETURN me();
END
$$;

GRANT EXECUTE ON FUNCTION set_my_name(text) TO player, admin;

-- What to call somebody else: their name if they have said one, and otherwise
-- the short form of their id, which is what the page showed before. Never the
-- email — that is theirs.
CREATE FUNCTION player_name(who uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
SELECT coalesce(nullif(btrim(u.name), ''), left(u.id::text, 8))
FROM auth.user u WHERE u.id = who;
$$;

GRANT EXECUTE ON FUNCTION player_name(uuid) TO anon, player, admin;

CREATE FUNCTION api.me() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.me()$$;
GRANT EXECUTE ON FUNCTION api.me() TO player, admin;

CREATE FUNCTION api.set_my_name(name text) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.set_my_name(name)$$;
GRANT EXECUTE ON FUNCTION api.set_my_name(text) TO player, admin;

CREATE FUNCTION api.player_name(who uuid) RETURNS text
LANGUAGE sql STABLE AS $$SELECT public.player_name(who)$$;
GRANT EXECUTE ON FUNCTION api.player_name(uuid) TO anon, player, admin;
