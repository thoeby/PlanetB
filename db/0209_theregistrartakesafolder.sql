-- 0209_theregistrartakesafolder.sql — a product's version is its file, its
-- flow and what that flow needs.
--
-- TASKS-live.md LV.8. No git, no Forgejo: a maker keeps a folder —
--
--   model.glb      the thing
--   product.json   its name, markings, triggers, needs, price, editions,
--                  licence, and how it is sold (channel policy)
--   flow.elx       what it does, run on a process server (optional)
--
-- — and tools/register.py puts it in the world. A version of a product is
-- therefore not only a file: a gate whose flow changed is a new version of
-- the gate, with the same GLB. `asset_version` carries the flow's hash, and
-- set_pointer takes it (a new overload: the five-argument one of db/0207
-- keeps working). Registering the same folder twice records nothing the
-- second time.

ALTER TABLE asset_version ADD COLUMN flow_sha256 text REFERENCES artifact (sha256);

-- The newest version of a product on a channel.
CREATE FUNCTION latest_version(p_san text, p_channel text DEFAULT 'current')
RETURNS asset_version
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT * FROM asset_version v WHERE v.san = p_san AND v.channel = p_channel
ORDER BY v.id DESC LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION latest_version(text, text) TO anon, player, admin, flow;

-- Moving a channel to a file, a flow and what it needs. The same three again
-- is no move at all.
CREATE FUNCTION set_pointer(p_san text, p_channel text, p_sha256 text, p_fix boolean,
                            p_needs jsonb, p_flow_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a    asset%ROWTYPE;
    last asset_version%ROWTYPE;
BEGIN
    SELECT * INTO a FROM asset WHERE san = p_san FOR UPDATE;
    IF a.san IS NULL OR a.creator_id IS DISTINCT FROM current_user_id() THEN
        RAISE EXCEPTION 'only its maker moves the pointer of %', p_san USING errcode = '42501';
    END IF;
    IF p_channel NOT IN ('current', 'legacy') THEN
        RAISE EXCEPTION 'a product has two channels, current and legacy' USING errcode = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM artifact WHERE sha256 = p_sha256
                   AND kind = asset_artifact_kind(a.type)) THEN
        RAISE EXCEPTION 'no % artifact %', asset_artifact_kind(a.type), p_sha256
            USING errcode = 'PT404';
    END IF;
    IF p_flow_sha256 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM artifact
        WHERE sha256 = p_flow_sha256 AND kind = 'flow') THEN
        RAISE EXCEPTION 'no flow artifact %', p_flow_sha256 USING errcode = 'PT404';
    END IF;
    last := latest_version(p_san, p_channel);
    IF a.pointer ->> p_channel IS NOT DISTINCT FROM p_sha256
       AND last.flow_sha256 IS NOT DISTINCT FROM p_flow_sha256
       AND last.needs IS NOT DISTINCT FROM coalesce(p_needs, '{}'::jsonb) THEN
        RETURN a.pointer;
    END IF;
    UPDATE asset SET pointer = pointer || jsonb_build_object(p_channel, p_sha256)
    WHERE san = p_san;
    INSERT INTO asset_version (san, sha256, channel, fix, needs, flow_sha256)
    VALUES (p_san, p_sha256, p_channel, coalesce(p_fix, false),
            coalesce(p_needs, '{}'::jsonb), p_flow_sha256);
    RETURN (SELECT pointer FROM asset WHERE san = p_san);
END
$$;

GRANT EXECUTE ON FUNCTION set_pointer(text, text, text, boolean, jsonb, text) TO player, admin;

-- The products a maker has made, by name: how the registrar finds the one a
-- folder is, when the folder does not say.
CREATE FUNCTION my_product(p_name text) RETURNS text
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT san FROM asset WHERE creator_id = current_user_id() AND name = p_name
ORDER BY created_at LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION my_product(text) TO player, admin;

CREATE OR REPLACE VIEW api.asset_version WITH (security_invoker = true)
AS SELECT * FROM public.asset_version;

CREATE FUNCTION api.set_pointer(san text, channel text, sha256 text, fix boolean,
                                needs jsonb, flow_sha256 text) RETURNS jsonb
LANGUAGE sql VOLATILE
AS $$SELECT public.set_pointer(san, channel, sha256, fix, needs, flow_sha256)$$;
CREATE FUNCTION api.my_product(name text) RETURNS text
LANGUAGE sql STABLE AS $$SELECT public.my_product(name)$$;
GRANT EXECUTE ON FUNCTION api.set_pointer(text, text, text, boolean, jsonb, text),
    api.my_product(text) TO player, admin;
