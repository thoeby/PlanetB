-- 0088_atileisdrawnwithitssiblings.sql — how many of a tile's siblings are
-- published, because that is what decides whether it is ever drawn.
--
-- client/js/traverse.js refines a tile into its children only when every child
-- the world has a row for is published: an unpublished child that exists is a
-- hole, and refining into it would tear the ground open. The rule is right and
-- its effect is a cliff nobody is told about — compiling one z16 of the sixteen
-- under a z14 draws nothing at all, and the same again for z18 under z16. A
-- player watching a trained tile finish, minutes at a time, and seeing no
-- change in the world is not doing anything wrong.
--
-- So the pool says it: of the tiles under this one's parent that the world
-- knows about, how many are published. `siblings` counts the rows that exist —
-- a child outside any compiled area has none, and is not a hole.
CREATE FUNCTION sibling_tiles(a_z int, a_x int, a_y int) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object(
    'siblings', count(*),
    'siblings_published', count(*) FILTER (WHERE t.published_version > 0))
FROM tile t
WHERE a_z > 6
  AND t.z = a_z
  AND t.x BETWEEN (a_x / 4) * 4 AND (a_x / 4) * 4 + 3
  AND t.y BETWEEN (a_y / 4) * 4 AND (a_y / 4) * 4 + 3;
$$;

GRANT EXECUTE ON FUNCTION sibling_tiles(int, int, int) TO anon, player, admin;

-- db/0087's render_pool, with those two numbers on every row.
CREATE OR REPLACE FUNCTION render_pool(p_lon double precision DEFAULT null,
                                       p_lat double precision DEFAULT null,
                                       p_limit int DEFAULT 40) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
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
) pool;
$$;
