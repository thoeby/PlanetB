-- 0142_thenearestworkisthenearestwork.sql — the pool cuts to the nearest
-- pieces, not to the oldest ones.
--
-- What was seen: a world with hundreds of open jobs, a player standing on
-- their own land, and a panel whose nearest entry was five kilometres away —
-- with every other entry in it five to seven kilometres away too, in the same
-- direction.
--
-- render_pool builds an `ordering` for each row — bounty, then how far the
-- tile is from the player, then zoom — and the outer jsonb_agg sorts by it.
-- But the inner query took its rows with
--
--     ORDER BY job.bounty DESC, job.id
--     LIMIT greatest(p_limit, 0)
--
-- and distance is in neither. Every job in a world without bounties is free,
-- so the tiebreak was job.id: the limit took the *oldest* jobs the world has,
-- and only then were those sorted by distance among themselves. A job opened
-- where the player is standing is the newest job there is — the highest id —
-- so it was cut before distance was ever looked at. The panel was a list of
-- the world's first sixty jobs, arranged by how near they happened to be.
--
-- The limit now cuts on what the list is sorted by. `ordering` stays as it is:
-- it is what presents the rows, and the two agreeing is the whole point.
--
-- db/0132's render_pool, cutting on distance as well as on pay.
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
        ORDER BY job.bounty DESC,
            CASE WHEN p_lon IS null THEN 0 ELSE
                st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                            st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography)
            END,
            job.id
        LIMIT greatest(p_limit, 0)
    ) pool
    );
END
$$;
