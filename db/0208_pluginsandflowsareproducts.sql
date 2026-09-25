-- 0208_pluginsandflowsareproducts.sql — a plugin and a flow are products.
--
-- TASKS-live.md LV.7. A block set somebody wrote (a plugin folder: its
-- plugin.xml and the composites under assets/) and a flow somebody drew (one
-- ELX) are made, named, licensed and paid for exactly as a model is, so they
-- are in the catalog as two more types:
--
--   plugin  the folder as a canonical tar — entries sorted by path, no
--           directories, mode 0644, no owner, mtime 0 (client/lib/tar.js,
--           tools/register.py) — so the same folder is the same SAN
--   flow    the ELX file itself
--
-- Same register_asset, same order. Installing one is the buyer's own tab
-- sending the folder to their chosen process server (client/flow/server/
-- plugins.js): the world sends nothing out (Invariant 9) and is told nothing
-- about where it was installed.

ALTER TABLE asset DROP CONSTRAINT asset_type_check;
ALTER TABLE asset ADD CONSTRAINT asset_type_check CHECK (type IN (
    'model', 'segment', 'profile', 'collection', 'material', 'plugin', 'flow'));

CREATE OR REPLACE FUNCTION asset_artifact_kind(p_type text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE p_type
    WHEN 'material' THEN 'material'
    WHEN 'profile' THEN 'profile'
    WHEN 'collection' THEN 'collection'
    WHEN 'plugin' THEN 'plugin'
    WHEN 'flow' THEN 'flow'
    ELSE 'glb' END;
$$;

-- db/0163's can_write, with the tar a plugin is stored as.
CREATE OR REPLACE FUNCTION can_write(path text, sha256 text, bytes bigint DEFAULT 0)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid   uuid := current_user_id();
    wid   uuid;
    m     text [];
    known boolean;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = 'PT401';
    END IF;
    IF can_write.sha256 IS NULL OR can_write.sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'a valid sha256 must be declared' USING errcode = 'PT403';
    END IF;
    known := EXISTS (SELECT 1 FROM artifact a WHERE a.sha256 = can_write.sha256);

    SELECT id INTO wid FROM worker WHERE user_id = uid;

    m := regexp_match(path, '^/jobs/([0-9]+)/[A-Za-z0-9._-]+$');
    IF m IS NOT NULL THEN
        IF known THEN
            RAISE EXCEPTION 'artifact already registered' USING errcode = 'PT403';
        END IF;
        IF EXISTS (SELECT 1 FROM atom
                   WHERE id = m[1]::bigint AND state = 'claimed'
                     AND worker_id = wid) THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'atom % is not claimed by you', m[1] USING errcode = 'PT403';
    END IF;

    m := regexp_match(path, '^/assets/([0-9a-f]{64})\.(glb|webp|elx|png|json|r32|tar)$');
    IF m IS NOT NULL THEN
        IF m[1] <> can_write.sha256 THEN
            RAISE EXCEPTION 'path does not match the declared sha256'
                USING errcode = 'PT403';
        END IF;
        RETURN;
    END IF;

    m := regexp_match(path,
        '^/tiles/([0-9]+)/([0-9]+)/([0-9]+)/([0-9a-f]{64})\.(sog|r16|json)$');
    IF m IS NOT NULL THEN
        IF m[4] <> can_write.sha256 THEN
            RAISE EXCEPTION 'path does not match the declared sha256'
                USING errcode = 'PT403';
        END IF;
        IF EXISTS (SELECT 1 FROM atom a
                   JOIN job j ON j.id = a.job_id
                   WHERE a.op = 'sog' AND a.worker_id = wid
                     AND a.state IN ('claimed', 'submitted', 'verified')
                     AND j.z = m[1]::int AND j.x = m[2]::int AND j.y = m[3]::int) THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'you hold no sog atom for %/%/%', m[1], m[2], m[3]
            USING errcode = 'PT403';
    END IF;

    RAISE EXCEPTION 'path % is not writable', path USING errcode = 'PT403';
END
$$;

-- A plugin names itself, in its plugin.xml: the id it is installed under.
CREATE OR REPLACE FUNCTION check_asset_type(p_type text, p_meta jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    strips jsonb := p_meta -> 'profile';
    lo     jsonb := p_meta -> 'bbox' -> 'min';
    hi     jsonb := p_meta -> 'bbox' -> 'max';
    px     int := (p_meta ->> 'px')::int;
BEGIN
    IF p_type = 'segment' THEN
        IF lo IS NULL OR hi IS NULL THEN
            RAISE EXCEPTION 'a repeating piece needs a measured model';
        END IF;
        IF (hi ->> 0)::double precision - (lo ->> 0)::double precision < 0.1 THEN
            RAISE EXCEPTION 'a repeating piece must be at least 0.10 m long';
        END IF;
    ELSIF p_type = 'profile' THEN
        IF jsonb_typeof(strips) <> 'array' OR jsonb_array_length(strips) = 0 THEN
            RAISE EXCEPTION 'a cross-section needs at least one strip';
        END IF;
    ELSIF p_type = 'material' THEN
        IF px IS NULL OR px < 1 OR px > 2048 THEN
            RAISE EXCEPTION 'a surface material is a square png of at most 2048 px';
        END IF;
        IF (px & (px - 1)) <> 0 THEN
            RAISE EXCEPTION 'a surface material is a power of two: %s is not', px;
        END IF;
        IF coalesce((p_meta ->> 'tiling')::double precision, 0) <= 0 THEN
            RAISE EXCEPTION 'a surface material needs a tiling size in metres';
        END IF;
    ELSIF p_type = 'plugin' THEN
        IF NOT marks_token(coalesce(p_meta #>> '{parts,plugin}', '')) THEN
            RAISE EXCEPTION 'a plugin says its id, as its plugin.xml does';
        END IF;
    END IF;
END
$$;
