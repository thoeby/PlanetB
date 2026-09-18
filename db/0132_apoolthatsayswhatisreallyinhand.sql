-- 0132_apoolthatsayswhatisreallyinhand.sql — the pool takes back what nobody
-- is holding, and how long it waits is the operator's choice.
--
-- Two halves of one thing. A tab that goes away says so (db/0079's
-- hand_back_atom, on pagehide), and when that goodbye is lost — the tab closed
-- while its claim was still in flight, a race a fast machine wins often — the
-- backstop is the lease: expire_claims hands the piece back once nobody has
-- beaten for it. But expire_claims only ever ran inside claim_atom, so a pool
-- nobody was claiming from went on saying "1 in hand" about a tab that had
-- gone, and the person reading it was told something untrue.
--
-- render_pool takes back what is dead before it counts. It is a player's own
-- call and nothing on the server decides to make it (Invariant 9): somebody
-- looking at the pool does. db/0087's body, unchanged, under a function that
-- may write.
--
-- And the wait is a number the operator can set, the way db/0131's sizes are:
--
--     ALTER DATABASE splatworld SET splatworld.lease = '20 seconds';
--
-- Unset it is what it was — five minutes, and half an hour for training
-- (db/0090). `make player-run` turns it down, so that "a render somebody
-- walked away from is back in the pool" is something a story can watch happen
-- rather than wait five minutes for.
CREATE OR REPLACE FUNCTION claim_patience(p_op text) RETURNS interval
LANGUAGE sql STABLE AS $$
SELECT coalesce(
    nullif(current_setting('splatworld.lease', true), '')::interval,
    CASE WHEN p_op = 'train' THEN interval '30 minutes'
         ELSE interval '5 minutes' END);
$$;

REVOKE ALL ON FUNCTION claim_patience(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION render_pool(p_lon double precision DEFAULT null,
                                       p_lat double precision DEFAULT null,
                                       p_limit int DEFAULT 40)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM expire_claims();
    RETURN (
    SELECT coalesce(jsonb_agg(j ORDER BY j ->> 'ordering'), '[]'::jsonb)
    FROM (
        SELECT jsonb_build_object(
            'job', job.id, 'z', job.z, 'x', job.x, 'y', job.y,
            'bounty', job.bounty, 'version', job.target_version,
            'opened_at', job.created_at,
            'ready', (SELECT count(*) FROM atom a
                      WHERE a.job_id = job.id AND a.state = 'ready'),
            'blocked', (SELECT count(*) FROM atom a
                        WHERE a.job_id = job.id AND a.state = 'waiting'),
            'claimed', (SELECT count(*) FROM atom a
                        WHERE a.job_id = job.id AND a.state = 'claimed'),
            'failed', (SELECT count(*) FROM atom a
                       WHERE a.job_id = job.id AND a.state = 'failed'),
            'handed_back', (SELECT coalesce(sum(a.handed_back), 0) FROM atom a
                            WHERE a.job_id = job.id),
            'may_retry', may_retry_job(job.id),
            'made', CASE
                WHEN EXISTS (SELECT 1 FROM atom a
                             WHERE a.job_id = job.id AND a.op = 'train') THEN 'trained'
                WHEN EXISTS (SELECT 1 FROM atom a
                             WHERE a.job_id = job.id AND a.op = 'assemble') THEN 'assembled'
                ELSE 'merged from its children' END,
            'needs_webgpu', EXISTS (
                SELECT 1 FROM atom a WHERE a.job_id = job.id AND a.state = 'ready'
                  AND coalesce((a.params ->> 'needs_webgpu')::boolean, false)),
            'needs_mb', (SELECT coalesce(max(atom_buffer_mb(a)), 0) FROM atom a
                         WHERE a.job_id = job.id AND a.state = 'ready'),
            'metres', CASE WHEN p_lon IS null THEN null ELSE
                st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                            st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography) END,
            'ordering', lpad((1000000 - least(job.bounty, 999999))::bigint::text, 9, '0')
                || lpad(coalesce(CASE WHEN p_lon IS null THEN 0 ELSE
                    st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                                st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography)
                    END, 0)::bigint::text, 12, '0')
                || lpad((18 - job.z)::text, 2, '0'))
            || sibling_tiles(job.z, job.x, job.y) AS j
        FROM job
        INNER JOIN tile t ON t.z = job.z AND t.x = job.x AND t.y = job.y
        WHERE job.state = 'open'
          AND job.target_version = t.expected_version
          AND EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                      AND a.state IN ('ready', 'waiting', 'claimed', 'failed'))
          AND NOT EXISTS (SELECT 1 FROM atom a
                          WHERE a.job_id = job.id AND a.op = 'merge'
                            AND a.state IN ('ready', 'waiting')
                            AND NOT merge_has_a_child(a.inputs))
        ORDER BY job.bounty DESC, job.id
        LIMIT greatest(p_limit, 0)
    ) pool
    );
END
$$;

-- PostgREST reads the wrapper's volatility, not the body's: a function it
-- believes is STABLE runs in a read-only transaction, and taking a dead claim
-- back is a write. So the wrapper says what it does now — POST, as the page
-- already calls it.
CREATE OR REPLACE FUNCTION api.render_pool(lon double precision DEFAULT null,
                                           lat double precision DEFAULT null,
                                           "limit" int DEFAULT 40)
RETURNS jsonb
LANGUAGE sql VOLATILE AS $$
SELECT public.render_pool(lon, lat, "limit")
$$;

GRANT EXECUTE ON FUNCTION api.render_pool(double precision, double precision, int)
TO anon, player, admin;
