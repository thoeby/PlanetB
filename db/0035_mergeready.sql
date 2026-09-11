-- 0035_mergeready.sql — a merge with nothing to merge is not work.
--
-- A merge atom's children are pinned when the DAG is built (Invariant 2), as
-- sixteen sogs with '' for a child that was not published then. Every one of
-- them empty means the atom can only fail — `merge-v1` throws "no published
-- child" — and because it is `ready` with no deps, every tab claims it, fails,
-- and claims it again. A world compiles from the leaves up, so on a new world
-- that is all any tab sees.
--
-- Publishing a child marks its parent dirty (0006), which opens a new job and
-- builds a DAG with the child pinned, so nothing has to rewrite this atom:
-- skipping it is enough, and it becomes claimable again as itself only if the
-- same set is ever pinned again.

CREATE FUNCTION merge_has_a_child(a_inputs jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
        coalesce(a_inputs -> 'children', '[]'::jsonb)) AS c
    WHERE c <> ''
);
$$;

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
