-- 0082_whythepoolisempty.sql — a pool that says why it has nothing in it.
--
-- "Nothing waiting: every tile anybody submitted is compiled" is the one thing
-- the Render pool could say about an empty list, and it is not always true.
-- `render_pool` hides a job on purpose in three cases, all of them good
-- reasons and none of them visible:
--
--   * the world has moved past the version the job was opened for, so it could
--     finish every atom it has and publish none of them (Invariant 3);
--   * it is a merge of children nobody has published yet, which claim_atom and
--     claim_for refuse to hand out (db/0035_mergeready.sql), so listing it
--     would be offering work that cannot be taken;
--   * every atom of it has finished, and what is missing is a publish
--     (db/0081_compileitagain.sql).
--
-- Somebody who has just approved a submission and is looking at an empty pool
-- is looking at one of those. This says which, in the words the panel shows.
CREATE FUNCTION pool_held_back(p_limit int DEFAULT 40) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(h ORDER BY h ->> 'z', h ->> 'x', h ->> 'y'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object(
        'job', job.id, 'z', job.z, 'x', job.x, 'y', job.y,
        'why', CASE
            WHEN job.target_version <> t.expected_version
                THEN 'the land changed after this was opened — submit it again'
            WHEN EXISTS (SELECT 1 FROM atom a
                         WHERE a.job_id = job.id AND a.op = 'merge'
                           AND a.state IN ('ready', 'waiting')
                           AND NOT merge_has_a_child(a.inputs))
                THEN 'waiting for the finer tiles under it to be published'
            ELSE 'every piece of it is done — it is the publish that is missing'
        END) AS h
    FROM job
    INNER JOIN tile t ON t.z = job.z AND t.x = job.x AND t.y = job.y
    WHERE job.state = 'open'
      AND (job.target_version <> t.expected_version
           OR NOT EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                          AND a.state IN ('ready', 'waiting', 'claimed', 'failed'))
           OR EXISTS (SELECT 1 FROM atom a
                      WHERE a.job_id = job.id AND a.op = 'merge'
                        AND a.state IN ('ready', 'waiting')
                        AND NOT merge_has_a_child(a.inputs)))
    ORDER BY job.z, job.x, job.y
    LIMIT greatest(p_limit, 0)
) held;
$$;

GRANT EXECUTE ON FUNCTION pool_held_back(int) TO anon, player, admin;

CREATE FUNCTION api.pool_held_back(limit_ int DEFAULT 40) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT public.pool_held_back(limit_);
$$;

GRANT EXECUTE ON FUNCTION api.pool_held_back(int) TO anon, player, admin;
