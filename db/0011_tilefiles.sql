-- 0011_tilefiles.sql — a tile is more than its splats.
--
-- WP1.4 walks on `height.r16` and slides along `colliders.json`, both of which
-- belong to a tile exactly as its `.sog` does: same tile, same version, same
-- author. can_write only reserved `.sog` under /tiles, so there was no
-- authorised path for them. The rule is unchanged otherwise — only the worker
-- holding that tile's `sog` atom may write there, the declared sha256 still has
-- to match the filename, and Invariant 1 still forbids rewriting a path.
--
-- WP2.3's `assemble` produces the same two files as job artifacts; this is
-- where they land once a tile is published.

CREATE OR REPLACE FUNCTION can_write(path text, sha256 text, bytes bigint DEFAULT 0)
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

    -- /tiles/{z}/{x}/{y}/{sha}.sog|.r16|.json — the tile's splats, its
    -- heightmap and its colliders. Only the worker holding that tile's sog.
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
