-- 0024_progress.sql — helping render the world, and seeing how far it has got
-- (WP5.2).
--
-- A tab that offers to fill in the baseline wants different work from a tab
-- chasing a bounty: the cheap deterministic ops, and the tiles near enough that
-- their inputs are already in the browser's cache. Both are asked for through
-- `caps`, which claim_atom already carries and already filters on, so no RPC
-- signature changes: `ops` narrows what may be claimed, `near {lon, lat}`
-- orders what is left by how far it is from the player.
--
-- Bounty still comes first. Background rendering fills the gaps; it does not
-- get to starve work somebody has paid for.

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
    WHERE a2.state = 'ready'
      AND (ops IS NULL OR a2.op = ANY(ops))
      AND (NOT coalesce((a2.params ->> 'needs_webgpu')::boolean, false)
           OR coalesce((p_caps ->> 'webgpu')::boolean, false))
      AND coalesce((a2.params ->> 'min_vram_gb')::numeric, 0)
          <= coalesce((p_caps ->> 'vram_gb')::numeric, 0)
      AND coalesce(trust, 0) >= trust_min(a2.op)
      AND (a2.op <> 'verify' OR may_verify(a2.job_id, a2.id, wid))
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

-- ---------------------------------------------------------------- progress

-- How far the world has been compiled, a row per zoom. Public: what is drawn
-- and what is not is not a secret, and a dashboard that needs a token is a
-- dashboard nobody looks at.
CREATE VIEW progress AS
SELECT
    t.z,
    count(*) AS tiles,
    count(*) FILTER (WHERE t.published_version > 0) AS published,
    count(*) FILTER (WHERE t.dirty) AS dirty,
    count(*) FILTER (WHERE t.published_version > 0 AND NOT t.dirty) AS current,
    count(*) FILTER (WHERE t.suspect) AS suspect,
    (SELECT count(*) FROM job j WHERE j.z = t.z AND j.state = 'open') AS jobs_open,
    (SELECT count(*) FROM atom a INNER JOIN job j ON j.id = a.job_id
     WHERE j.z = t.z AND a.state = 'ready') AS atoms_ready,
    (SELECT count(*) FROM atom a INNER JOIN job j ON j.id = a.job_id
     WHERE j.z = t.z AND a.state = 'claimed') AS atoms_claimed,
    (SELECT count(*) FROM atom a INNER JOIN job j ON j.id = a.job_id
     WHERE j.z = t.z AND a.state = 'failed') AS atoms_failed
FROM tile t
GROUP BY t.z;

GRANT SELECT ON progress TO anon, player, admin;

CREATE VIEW api.progress WITH (security_invoker = true) AS SELECT * FROM public.progress;
GRANT SELECT ON api.progress TO anon, player, admin;
