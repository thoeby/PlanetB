-- 0134_theworldknowsacheckingserver.sql — one place for the operator's
-- settings, and the first of them: where a flow may be checked.
--
-- TASKS-foundation.md FND.2. A flow is drawn here and run somewhere else; the
-- somewhere else is a process server, and asking it "would you run this?" is
-- the only thing the page ever asks it. Its address is the operator's, like
-- the GeoServer's, so it lives in the world rather than in each tab.
--
-- Invariant 9 is untouched: the world stores the address and nothing more. No
-- server-side process talks to it — the player's own tab does, from the page.
CREATE TABLE app_setting (
    key    text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,40}$'),
    value  text NOT NULL,
    set_at timestamptz NOT NULL DEFAULT now(),
    set_by uuid
);

-- It is an address, not a secret: everybody's tab needs it to check a flow.
ALTER TABLE app_setting ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON app_setting FOR SELECT USING (true);
GRANT SELECT ON app_setting TO anon, player, admin;

CREATE FUNCTION set_app_setting(p_key text, p_value text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin changes the world''s settings'
            USING errcode = '42501';
    END IF;
    IF btrim(coalesce(p_value, '')) = '' THEN
        DELETE FROM app_setting WHERE app_setting.key = p_key;
        RETURN '';
    END IF;
    INSERT INTO app_setting (key, value, set_by)
    VALUES (p_key, btrim(p_value), current_user_id())
    ON CONFLICT (key) DO UPDATE
    SET value = excluded.value, set_at = now(), set_by = excluded.set_by;
    RETURN btrim(p_value);
END
$$;
GRANT EXECUTE ON FUNCTION set_app_setting(text, text) TO admin;

CREATE FUNCTION app_settings() RETURNS jsonb
LANGUAGE sql STABLE AS $$
SELECT coalesce(jsonb_object_agg(s.key, s.value), '{}'::jsonb) FROM app_setting s;
$$;
GRANT EXECUTE ON FUNCTION app_settings() TO anon, player, admin;

CREATE VIEW api.app_setting WITH (security_invoker = true)
AS SELECT * FROM public.app_setting;
GRANT SELECT ON api.app_setting TO anon, player, admin;

CREATE FUNCTION api.set_app_setting(key text, value text) RETURNS text
LANGUAGE sql VOLATILE AS $$SELECT public.set_app_setting(key, value)$$;
GRANT EXECUTE ON FUNCTION api.set_app_setting(text, text) TO admin;

CREATE FUNCTION api.app_settings() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.app_settings()$$;
GRANT EXECUTE ON FUNCTION api.app_settings() TO anon, player, admin;
