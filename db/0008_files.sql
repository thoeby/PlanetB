-- 0008_files.sql — the authorisation half of the immutable file store.
-- nginx computes nothing: it asks this function whether a PUT may proceed.
--
-- v1 caveat (accepted, ARCHITECTURE open decision 3): the client declares the
-- sha256 of what it is about to upload and nothing re-hashes the bytes at PUT
-- time. Integrity is established later, when a verify or hash check downloads
-- the artifact again. A worker can therefore upload bytes that do not match the
-- name it claimed; it just cannot make anyone accept them.

CREATE FUNCTION can_write(path text, sha256 text, bytes bigint DEFAULT 0)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid  uuid := current_user_id();
    wid  uuid;
    m    text [];
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = 'PT401';
    END IF;
    IF can_write.sha256 IS NULL OR can_write.sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'a valid sha256 must be declared' USING errcode = 'PT403';
    END IF;
    -- Invariant 1: an artifact that already exists is never rewritten.
    IF EXISTS (SELECT 1 FROM artifact a WHERE a.sha256 = can_write.sha256) THEN
        RAISE EXCEPTION 'artifact already registered' USING errcode = 'PT403';
    END IF;

    SELECT id INTO wid FROM worker WHERE user_id = uid;

    -- /jobs/{atom_id}/{name} — intermediate results, reserved by the claim.
    m := regexp_match(path, '^/jobs/([0-9]+)/[A-Za-z0-9._-]+$');
    IF m IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM atom
                   WHERE id = m[1]::bigint AND state = 'claimed'
                     AND worker_id = wid) THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'atom % is not claimed by you', m[1] USING errcode = 'PT403';
    END IF;

    -- /assets/{sha}.glb|.webp — catalog uploads by any authenticated user.
    m := regexp_match(path, '^/assets/([0-9a-f]{64})\.(glb|webp)$');
    IF m IS NOT NULL THEN
        IF m[1] <> can_write.sha256 THEN
            RAISE EXCEPTION 'path does not match the declared sha256'
                USING errcode = 'PT403';
        END IF;
        RETURN;
    END IF;

    -- /tiles/{z}/{x}/{y}/{sha}.sog — only the worker holding that tile's sog.
    m := regexp_match(path, '^/tiles/([0-9]+)/([0-9]+)/([0-9]+)/([0-9a-f]{64})\.sog$');
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

GRANT EXECUTE ON FUNCTION can_write(text, text, bigint) TO anon, player, admin;

CREATE FUNCTION api.can_write(path text, sha256 text, bytes bigint DEFAULT 0)
RETURNS void LANGUAGE sql STABLE
AS $$SELECT public.can_write(path, sha256, bytes)$$;
GRANT EXECUTE ON FUNCTION api.can_write(text, text, bigint) TO anon, player, admin;
