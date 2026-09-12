-- 0052_staleclaim.sql — no worker is given a compile that cannot be published.
--
-- A job pins the version it compiles: publish_tile() is a compare-and-swap on
-- tile.expected_version (Invariant 3), so a job whose target is behind the tile
-- can finish every atom it has and publish none of them. The worker sees
-- "stale", and the tile is no closer to being drawn than before.
--
-- That is not a rare race. Publishing a child dirties its parent, so a world
-- whose jobs were opened together — the build panel opens one per tile of the
-- ladder — moves every ancestor's expected_version the moment the first z14
-- lands. The z12, z10, z8 and z6 jobs opened alongside it are superseded
-- before they start, and their merges keep being claimed, run, and thrown
-- away, for ever, because nothing ever calls ensure_job() for those tiles
-- again to cancel them.
--
-- ensure_job() already cancels a superseded job when it is next asked for one.
-- This is the other half: until it is asked, the atoms of such a job are not
-- offered. Nothing is created or destroyed here (Invariant 4) — a job whose
-- tile comes back to its version is claimable again, unchanged.

CREATE OR REPLACE FUNCTION claim_atom(p_caps jsonb DEFAULT '{}'::jsonb) RETURNS atom
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid   uuid;
    trust numeric;
    a     atom%rowtype;
    ops   text [] := CASE WHEN jsonb_typeof(p_caps -> 'ops') = 'array'
                          THEN ARRAY(SELECT jsonb_array_elements_text(p_caps -> 'ops')) END;
    near  geometry := CASE WHEN jsonb_typeof(p_caps -> 'near') = 'object'
                           THEN st_setsrid(st_makepoint(
                               (p_caps -> 'near' ->> 'lon')::double precision,
                               (p_caps -> 'near' ->> 'lat')::double precision), 4326) END;
BEGIN
    PERFORM expire_claims();
    wid := my_worker(p_caps);
    SELECT w.trust INTO trust FROM worker w WHERE w.id = wid;

    SELECT a2.* INTO a
    FROM atom a2
    INNER JOIN job j ON j.id = a2.job_id AND j.state = 'open'
    -- The tile this job compiles, and the version it still wants.
    INNER JOIN tile t ON t.z = j.z AND t.x = j.x AND t.y = j.y
    WHERE a2.state = 'ready'
      AND j.target_version = t.expected_version
      AND (ops IS NULL OR a2.op = ANY(ops))
      AND (NOT coalesce((a2.params ->> 'needs_webgpu')::boolean, false)
           OR coalesce((p_caps ->> 'webgpu')::boolean, false))
      AND coalesce((a2.params ->> 'min_vram_gb')::numeric, 0)
          <= coalesce((p_caps ->> 'vram_gb')::numeric, 0)
      AND coalesce(trust, 0) >= trust_min(a2.op)
      AND (a2.op <> 'verify' OR may_verify(a2.job_id, a2.id, wid))
      AND (a2.op <> 'merge' OR merge_has_a_child(a2.inputs))
    ORDER BY j.bounty DESC,
        -- Nearest first, and only when a position was given: a tile whose DEM,
        -- ortho and children this tab has already fetched is the cheapest work
        -- it can possibly do.
        CASE WHEN near IS NULL THEN 0
             ELSE st_distance(st_centroid(tile_bbox(j.z, j.x, j.y)), near) END,
        a2.id
    FOR UPDATE OF a2 SKIP LOCKED
    LIMIT 1;

    IF a.id IS NULL THEN
        RETURN NULL;
    END IF;

    -- The claim also reserves /jobs/{atom_id}/ for this worker; can_write
    -- (WP0.10) allows uploads there and nowhere else.
    UPDATE atom SET state = 'claimed', worker_id = wid,
                    claimed_at = now(), heartbeat_at = now()
    WHERE id = a.id RETURNING * INTO a;
    RETURN a;
END
$$;
