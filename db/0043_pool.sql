-- 0043_pool.sql — submitting, and the pool anybody can render from.
--
-- TASKS-usable T6. You place things on your land and press Submit. Every tile
-- your land covers that is out of date goes into a public pool with the price
-- you attached; anybody's browser can take one, render it and be paid. You may
-- also attach nothing and render it yourself.
--
-- Nothing new drives the compiling: ensure_job builds the DAG, set_bounty
-- escrows the money and release_escrow pays it out on publish. This is the door
-- to those, plus the one question a pool needs to answer — what is waiting, what
-- does it pay, and how far away is it.

-- Finest first: a z14 tile is what somebody is standing in, and its parents are
-- merges that follow on their own once it is published (db/0006_publish.sql
-- dirties the parent). Submitting a whole area therefore opens the leaves and
-- lets the ladder climb itself.
CREATE FUNCTION submit_area(p_area uuid, p_price numeric DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a      area%rowtype;
    t      record;
    jid    bigint;
    opened int := 0;
    spent  numeric := 0;
BEGIN
    SELECT * INTO a FROM area WHERE area.id = p_area;
    IF a.id IS NULL THEN
        RAISE EXCEPTION 'no such area %', p_area;
    END IF;
    IF NOT is_area_writer(p_area) THEN
        RAISE EXCEPTION 'that is not your land' USING errcode = '42501';
    END IF;
    IF coalesce(p_price, 0) < 0 THEN
        RAISE EXCEPTION 'a price is not negative';
    END IF;

    FOR t IN
        SELECT tile.z, tile.x, tile.y FROM tile
        WHERE tile.dirty AND tile.expected_version > 0
          AND st_intersects(a.geom, tile_bbox(tile.z, tile.x, tile.y))
        ORDER BY tile.z DESC, tile.x, tile.y
    LOOP
        jid := ensure_job(t.z, t.x, t.y, coalesce(p_price, 0));
        opened := opened + 1;
        spent := spent + coalesce(p_price, 0);
    END LOOP;

    RETURN jsonb_build_object('tiles', opened, 'spent', spent,
                              'price_each', coalesce(p_price, 0));
END
$$;

-- What is waiting to be rendered, nearest and best-paid first. Public: anybody
-- may look, and a tab that is not signed in can still show the work it could do
-- if its owner signed in.
CREATE FUNCTION render_pool(p_lon double precision DEFAULT NULL,
                            p_lat double precision DEFAULT NULL,
                            p_limit int DEFAULT 40) RETURNS jsonb
-- search_path is pinned on every reader here for the same reason as in
-- db/0044_permission.sql: PostgREST puts `api` first, and api.tile is a
-- narrower view of public.tile.
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(j ORDER BY j ->> 'ordering'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object(
        'job', job.id, 'z', job.z, 'x', job.x, 'y', job.y,
        'bounty', job.bounty, 'version', job.target_version,
        'opened_at', job.created_at,
        'ready', (SELECT count(*) FROM atom a
                  WHERE a.job_id = job.id AND a.state IN ('ready', 'waiting')),
        'claimed', (SELECT count(*) FROM atom a
                    WHERE a.job_id = job.id AND a.state = 'claimed'),
        'metres', CASE WHEN p_lon IS NULL THEN NULL ELSE
            st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                        st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography) END,
        -- Best paid first; among equals, nearest; among those, deepest, because
        -- a leaf is what somebody is waiting to walk on.
        'ordering', lpad((1000000 - least(job.bounty, 999999))::bigint::text, 9, '0')
            || lpad(coalesce(CASE WHEN p_lon IS NULL THEN 0 ELSE
                st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                            st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography)
                END, 0)::bigint::text, 12, '0')
            || lpad((18 - job.z)::text, 2, '0')) AS j
    FROM job
    WHERE job.state = 'open'
      AND EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                  AND a.state IN ('ready', 'waiting', 'claimed'))
    ORDER BY job.bounty DESC, job.id
    LIMIT greatest(p_limit, 0)
) pool;
$$;
GRANT EXECUTE ON FUNCTION render_pool(double precision, double precision, int)
TO anon, player, admin;

-- One job's work, for a tab that chose that job out of the pool. The same rules
-- as claim_atom — it is claim_atom, with the pool's choice narrowing it.
CREATE FUNCTION claim_for(p_job bigint, p_caps jsonb DEFAULT '{}'::jsonb)
RETURNS atom
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid uuid;
    a   atom%rowtype;
BEGIN
    PERFORM expire_claims();
    wid := my_worker(p_caps);

    SELECT a2.* INTO a
    FROM atom a2
    JOIN job j ON j.id = a2.job_id AND j.state = 'open'
    WHERE a2.job_id = p_job
      AND a2.state = 'ready'
  AND (a2.op <> 'merge' OR merge_has_a_child(a2.inputs))
      AND (NOT coalesce((a2.params ->> 'needs_webgpu')::boolean, false)
           OR coalesce((p_caps ->> 'webgpu')::boolean, false))
      AND coalesce((a2.params ->> 'min_vram_gb')::numeric, 0)
          <= coalesce((p_caps ->> 'vram_gb')::numeric, 0)
    ORDER BY a2.id
    FOR UPDATE OF a2 SKIP LOCKED
    LIMIT 1;

    IF a.id IS NULL THEN
        RETURN NULL;
    END IF;
    UPDATE atom SET state = 'claimed', worker_id = wid,
                    claimed_at = now(), heartbeat_at = now()
    WHERE atom.id = a.id RETURNING * INTO a;
    RETURN a;
END
$$;
GRANT EXECUTE ON FUNCTION claim_for(bigint, jsonb) TO player, admin;

-- How far along your land is, for the owner: what is compiled, what is waiting,
-- and what it is costing.
CREATE FUNCTION area_progress(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object(
    'tiles', count(*),
    'published', count(*) FILTER (WHERE t.published_version >= t.expected_version),
    'waiting', count(*) FILTER (WHERE t.dirty),
    'open_jobs', (SELECT count(*) FROM job j
                  WHERE j.state = 'open' AND EXISTS (
                      SELECT 1 FROM area a WHERE a.id = p_area
                        AND st_intersects(a.geom, tile_bbox(j.z, j.x, j.y)))),
    'in_escrow', coalesce((SELECT sum(j.bounty) FROM job j
                  WHERE j.state = 'open' AND EXISTS (
                      SELECT 1 FROM area a WHERE a.id = p_area
                        AND st_intersects(a.geom, tile_bbox(j.z, j.x, j.y)))), 0))
FROM tile t
WHERE EXISTS (SELECT 1 FROM area a WHERE a.id = p_area
              AND st_intersects(a.geom, tile_bbox(t.z, t.x, t.y)));
$$;
GRANT EXECUTE ON FUNCTION area_progress(uuid) TO anon, player, admin;

GRANT EXECUTE ON FUNCTION submit_area(uuid, numeric) TO player, admin;

CREATE FUNCTION api.submit_area(area_id uuid, price numeric DEFAULT 0) RETURNS jsonb
LANGUAGE sql AS $$SELECT public.submit_area(area_id, price)$$;
GRANT EXECUTE ON FUNCTION api.submit_area(uuid, numeric) TO player, admin;

CREATE FUNCTION api.render_pool(lon double precision DEFAULT NULL,
                                lat double precision DEFAULT NULL,
                                "limit" int DEFAULT 40) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.render_pool(lon, lat, "limit")$$;
GRANT EXECUTE ON FUNCTION api.render_pool(double precision, double precision, int)
TO anon, player, admin;

CREATE FUNCTION api.claim_for(job_id bigint, caps jsonb DEFAULT '{}'::jsonb)
RETURNS public.atom
LANGUAGE sql AS $$SELECT public.claim_for(job_id, caps)$$;
GRANT EXECUTE ON FUNCTION api.claim_for(bigint, jsonb) TO player, admin;

CREATE FUNCTION api.area_progress(area_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.area_progress(area_id)$$;
GRANT EXECUTE ON FUNCTION api.area_progress(uuid) TO anon, player, admin;
