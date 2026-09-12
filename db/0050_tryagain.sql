-- 0050_tryagain.sql — a tile that failed can be tried again, from the world.
--
-- Three bad attempts and an atom is `failed` for good (db/0005_state.sql),
-- which is right while the reason is the work itself. It is wrong when the
-- reason was outside it: a GeoServer that had not been set up yet failed every
-- assemble three times, and the tiles were then stuck for ever with nothing on
-- any screen to do about it — the pool still listed them, the tab claimed
-- nothing, and nobody was told why.
--
-- reset_atom (db/0038_authoring.sql) already does this for one atom and decides
-- who may. This is the same decision for a whole job, because a person looking
-- at a tile in the render pool is not thinking in atoms.
CREATE FUNCTION may_retry_job(p_job bigint) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT current_user_role() = 'admin' OR EXISTS (
    SELECT 1 FROM job j, area a
    WHERE j.id = p_job AND is_area_writer(a.id)
      AND st_intersects(a.geom, tile_bbox(j.z, j.x, j.y)));
$$;
GRANT EXECUTE ON FUNCTION may_retry_job(bigint) TO anon, player, admin;

CREATE FUNCTION retry_job(p_job bigint) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    n int := 0;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    IF NOT may_retry_job(p_job) THEN
        RAISE EXCEPTION 'that ground is not yours to render again'
            USING errcode = '42501';
    END IF;
    UPDATE atom SET state = CASE WHEN cardinality(deps) = 0 THEN 'ready'
                                 ELSE 'waiting' END,
                    attempts = 0, output_sha256 = NULL, result = NULL,
                    worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
    WHERE job_id = p_job AND state = 'failed';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
        UPDATE job SET state = 'open' WHERE id = p_job AND state <> 'cancelled';
        PERFORM advance_atoms(p_job);
    END IF;
    RETURN n;
END
$$;
GRANT EXECUTE ON FUNCTION retry_job(bigint) TO player, admin;

-- What is stuck, and whether the person looking may unstick it.
CREATE OR REPLACE FUNCTION render_pool(p_lon double precision DEFAULT NULL,
                            p_lat double precision DEFAULT NULL,
                            p_limit int DEFAULT 40) RETURNS jsonb
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
        'failed', (SELECT count(*) FROM atom a
                   WHERE a.job_id = job.id AND a.state = 'failed'),
        'may_retry', may_retry_job(job.id),
        'metres', CASE WHEN p_lon IS NULL THEN NULL ELSE
            st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                        st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography) END,
        'ordering', lpad((1000000 - least(job.bounty, 999999))::bigint::text, 9, '0')
            || lpad(coalesce(CASE WHEN p_lon IS NULL THEN 0 ELSE
                st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                            st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography)
                END, 0)::bigint::text, 12, '0')
            || lpad((18 - job.z)::text, 2, '0')) AS j
    FROM job
    WHERE job.state = 'open'
      -- A job whose every atom has failed still belongs here: it is what
      -- somebody has to look at, and now there is a button for it.
      AND EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                  AND a.state IN ('ready', 'waiting', 'claimed', 'failed'))
    ORDER BY job.bounty DESC, job.id
    LIMIT greatest(p_limit, 0)
) pool;
$$;
GRANT EXECUTE ON FUNCTION render_pool(double precision, double precision, int)
TO anon, player, admin;

CREATE FUNCTION api.retry_job(job_id bigint) RETURNS int
LANGUAGE sql AS $$SELECT public.retry_job(job_id)$$;
GRANT EXECUTE ON FUNCTION api.retry_job(bigint) TO player, admin;
