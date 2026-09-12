-- 0051_sharedbytes.sql — the same bytes belong to more than one tile.
--
-- A tile with no buildings has `{"boxes":[]}` for its colliders, and so does
-- every other tile with no buildings: one sha, one artifact row, and a copy
-- owed to each tile's own directory, because that is the address the viewer
-- asks for. The first tile wrote it and registered it; every tile after that
-- was refused at its own address — can_write raises "artifact already
-- registered" before it looks at the path — and the bytes it was refused were
-- under another tile, where nothing could find them. Every such tile's sog
-- atom failed, three times, for good.
--
-- Invariant 1 is about a path, not about a sha: an artifact is immutable and
-- content-addressed, and writing the same content at a second content-
-- addressed path is not a rewrite. `/tiles/…/{sha}.ext` and `/assets/{sha}.ext`
-- both carry the sha in the name and both check it against the declared one,
-- so the bytes at that address are the same bytes or they are already a lie
-- the v1 caveat allows (nothing re-hashes at PUT; a verify catches it later).
--
-- /jobs/{atom}/… keeps the refusal. It is a working directory, the client
-- already asks where an artifact it holds really lives, and a second copy of
-- an intermediate result is waste rather than an address someone needs.

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

    -- /jobs/{atom_id}/{name} — intermediate results, reserved by the claim.
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
