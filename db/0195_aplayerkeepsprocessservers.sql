-- 0195_aplayerkeepsprocessservers.sql — the process servers a player talks to.
--
-- TASKS-flows.md FL.1. A player may have several process servers — their own
-- machine, a test box, a friend's — and Automate switches between them. The
-- world keeps the list so it follows the player to another machine; it keeps
-- the address and the name and nothing else, and never talks to any of them.
--
-- Invariant 9: storing an address is not sending anything out. The player's
-- own tab is what calls it.

CREATE TABLE process_server (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id   uuid NOT NULL REFERENCES auth.user (id) ON DELETE CASCADE,
    name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
    url        text NOT NULL CHECK (url ~ '^https?://[^/?#\s]+/?$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE UNIQUE INDEX process_server_name_idx ON process_server (owner_id, name)
WHERE deleted_at IS NULL;

-- Invariant 6: an address can say where somebody's machine is, so a player
-- sees their own and nobody else's — not even an admin.
ALTER TABLE process_server ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_own ON process_server FOR SELECT
USING (owner_id = current_user_id());
GRANT SELECT ON process_server TO player, admin;

-- Add one (p_id null) or change one of your own. Refusals are the sentences
-- the Add a server dialog shows (docs/design/flows-servers.md §1a).
CREATE FUNCTION save_process_server(p_id uuid, p_name text, p_url text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    me  uuid := current_user_id();
    nm  text := btrim(coalesce(p_name, ''));
    adr text := btrim(coalesce(p_url, ''));
BEGIN
    IF me IS NULL THEN
        RAISE EXCEPTION 'sign in first' USING errcode = '42501';
    END IF;
    IF nm = '' THEN
        RAISE EXCEPTION 'A server needs a name.';
    END IF;
    IF adr !~ '^https?://[^/?#\s]+/?$' THEN
        RAISE EXCEPTION 'A server address starts with http:// or https://.';
    END IF;
    IF EXISTS (SELECT 1 FROM process_server s
               WHERE s.owner_id = me AND s.name = nm AND s.deleted_at IS NULL
                 AND s.id IS DISTINCT FROM p_id) THEN
        RAISE EXCEPTION 'You already have a server called %.', nm;
    END IF;
    IF p_id IS NULL THEN
        INSERT INTO process_server (owner_id, name, url)
        VALUES (me, nm, rtrim(adr, '/'))
        RETURNING process_server.id INTO p_id;
        RETURN p_id;
    END IF;
    UPDATE process_server SET name = nm, url = rtrim(adr, '/')
    WHERE process_server.id = p_id AND owner_id = me AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That is not one of your servers.' USING errcode = '42501';
    END IF;
    RETURN p_id;
END
$$;
GRANT EXECUTE ON FUNCTION save_process_server(uuid, text, text) TO player, admin;

CREATE FUNCTION delete_process_server(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE process_server SET deleted_at = now()
    WHERE process_server.id = p_id AND owner_id = current_user_id()
      AND deleted_at IS NULL;
    RETURN FOUND;
END
$$;
GRANT EXECUTE ON FUNCTION delete_process_server(uuid) TO player, admin;

-- ---------------------------------------------------------------- the api

CREATE VIEW api.process_server WITH (security_invoker = true) AS
SELECT
    id,
    name,
    url,
    created_at
FROM public.process_server
WHERE deleted_at IS NULL;
GRANT SELECT ON api.process_server TO player, admin;

CREATE FUNCTION api.save_process_server(id uuid, name text, url text)
RETURNS uuid
LANGUAGE sql VOLATILE AS $$SELECT public.save_process_server(id, name, url)$$;
GRANT EXECUTE ON FUNCTION api.save_process_server(uuid, text, text)
TO player, admin;

CREATE FUNCTION api.delete_process_server(id uuid) RETURNS boolean
LANGUAGE sql VOLATILE AS $$SELECT public.delete_process_server(id)$$;
GRANT EXECUTE ON FUNCTION api.delete_process_server(uuid) TO player, admin;
