-- 0153_ajobisatthestepithasgotto.sql — which kind of work a job is, and the
-- steps it is made of.
--
-- db/0152 read the phase off what could be *taken* right now: a job was
-- `train` only while its training atom was in state `ready`. The moment a tab
-- claimed that training the job fell back to `render`, because nothing ready
-- was left — so a tile this machine was training for a quarter of an hour sat
-- in Render jobs, which is the one tab it was not in.
--
-- A job is a chain of steps — assemble, the frames, the training, the packing
-- — and anybody may take any of them that is ready; the job's phase is which
-- step the chain has got to, not who is holding it. Submitted counts as done:
-- an atom whose output is uploaded and waiting on its checks is not work
-- anybody can take.
CREATE OR REPLACE VIEW pool_open AS
SELECT job.id AS job_id, job.z, job.x, job.y, job.bounty, job.target_version,
    CASE
        WHEN EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                       AND a.op IN ('assemble', 'frame')
                       AND a.state NOT IN ('verified', 'submitted')) THEN 'render'
        WHEN EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                       AND a.op = 'train'
                       AND a.state NOT IN ('verified', 'submitted')) THEN 'train'
        ELSE 'publish' END AS phase,
    may_retry_job(job.id) AS mine
FROM job
INNER JOIN tile t ON t.z = job.z AND t.x = job.x AND t.y = job.y
WHERE job.state = 'open'
  AND job.target_version = t.expected_version
  AND EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
              AND a.state IN ('ready', 'waiting', 'claimed', 'failed'))
  AND NOT EXISTS (SELECT 1 FROM atom a
                  WHERE a.job_id = job.id AND a.op = 'merge'
                    AND a.state IN ('ready', 'waiting')
                    AND NOT merge_has_a_child(a.inputs));

-- db/0152's pool_row, with the steps on it. The panel drew a job as one thing
-- with a button, and a compile is four things in a row that four different
-- people may do: this is what it is made of and how far each part has got, in
-- the order build_dag lays them out (db/0151).
CREATE OR REPLACE FUNCTION job_steps(p_job bigint) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
        'op', s.op, 'done', s.done, 'total', s.total, 'state', s.state)
    ORDER BY s.rank), '[]'::jsonb)
FROM (
    SELECT a.op,
        CASE a.op WHEN 'assemble' THEN 1 WHEN 'merge' THEN 1 WHEN 'frame' THEN 2
                  WHEN 'train' THEN 3 WHEN 'sog' THEN 4 ELSE 5 END AS rank,
        count(*) AS total,
        count(*) FILTER (WHERE a.state IN ('verified', 'submitted')) AS done,
        CASE
            WHEN count(*) FILTER (WHERE a.state = 'failed') > 0 THEN 'stopped'
            WHEN count(*) = count(*) FILTER (WHERE a.state IN ('verified', 'submitted'))
                THEN 'done'
            WHEN count(*) FILTER (WHERE a.state = 'claimed') > 0 THEN 'in hand'
            WHEN count(*) FILTER (WHERE a.state = 'ready') > 0 THEN 'to do'
            ELSE 'waiting' END AS state
    FROM atom a WHERE a.job_id = p_job GROUP BY a.op) AS s;
$$;

GRANT EXECUTE ON FUNCTION job_steps(bigint) TO anon, player, admin;

CREATE OR REPLACE FUNCTION pool_row(p_job bigint, p_lon double precision DEFAULT null,
                         p_lat double precision DEFAULT null) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object(
    'job', p.job_id, 'z', p.z, 'x', p.x, 'y', p.y,
    'bounty', p.bounty, 'version', p.target_version, 'phase', p.phase,
    'ready', (SELECT count(*) FROM atom a
              WHERE a.job_id = p.job_id AND a.state = 'ready'),
    'blocked', (SELECT count(*) FROM atom a
                WHERE a.job_id = p.job_id AND a.state = 'waiting'),
    'claimed', (SELECT count(*) FROM atom a
                WHERE a.job_id = p.job_id AND a.state = 'claimed'),
    'failed', (SELECT count(*) FROM atom a
               WHERE a.job_id = p.job_id AND a.state = 'failed'),
    'handed_back', (SELECT coalesce(sum(a.handed_back), 0) FROM atom a
                    WHERE a.job_id = p.job_id),
    'frames', (SELECT count(*) FROM atom a
               WHERE a.job_id = p.job_id AND a.op = 'frame'),
    'frames_done', (SELECT count(*) FROM atom a
                    WHERE a.job_id = p.job_id AND a.op = 'frame'
                      AND a.state = 'verified'),
    'steps', job_steps(p.job_id),
    'may_retry', may_retry_job(p.job_id),
    'made', CASE
        WHEN EXISTS (SELECT 1 FROM atom a
                     WHERE a.job_id = p.job_id AND a.op = 'train') THEN 'trained'
        WHEN EXISTS (SELECT 1 FROM atom a
                     WHERE a.job_id = p.job_id AND a.op = 'assemble') THEN 'assembled'
        ELSE 'merged from its children' END,
    'needs_webgpu', EXISTS (
        SELECT 1 FROM atom a WHERE a.job_id = p.job_id AND a.state = 'ready'
          AND coalesce((a.params ->> 'needs_webgpu')::boolean, false)),
    'needs_mb', (SELECT coalesce(max(atom_buffer_mb(a)), 0) FROM atom a
                 WHERE a.job_id = p.job_id AND a.state = 'ready'),
    'metres', CASE WHEN p_lon IS null THEN null ELSE
        st_distance(st_centroid(tile_bbox(p.z, p.x, p.y))::geography,
                    st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography) END,
    'log', coalesce((
        SELECT jsonb_agg(jsonb_build_object('kind', e.kind, 'op', e.op,
                                            'detail', e.detail, 'at', e.at)
               ORDER BY e.id DESC)
        FROM (SELECT * FROM tile_event e2
              WHERE e2.z = p.z AND e2.x = p.x AND e2.y = p.y
              ORDER BY e2.id DESC LIMIT 6) AS e), '[]'::jsonb))
    || sibling_tiles(p.z, p.x, p.y)
FROM pool_open p WHERE p.job_id = p_job;
$$;

GRANT EXECUTE ON FUNCTION pool_row(bigint, double precision, double precision)
TO anon, player, admin;
