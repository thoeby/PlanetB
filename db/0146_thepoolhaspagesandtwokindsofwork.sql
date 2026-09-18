-- 0146_thepoolhaspagesandtwokindsofwork.sql — the pool is readable a page at
-- a time, it says which of two kinds of work a tile is waiting for, and the
-- frames of a tile can be asked for again.
--
-- The panel asked for sixty rows and showed a list. Sixty is not all of them,
-- and a list of sixty identical lines is not something a person reads. So:
-- a page at a time with a total to page against, and a phase, because
-- path-tracing forty-five views and training a tile on them are different
-- work that different machines are good at and different people can do at the
-- same time. claim_atom has taken a `caps.ops` since db/0083; nothing in the
-- pool ever said which tiles had which kind waiting.
--
-- `render_pool` is left exactly as it is: a dozen tests and the e2e specs read
-- it, and this adds rather than moves.
--
-- A job is in the `train` phase when the next thing anybody can take on it is
-- the training run; in `render` when it is the ground, the frames, the merge
-- or the packing. Nothing is in both, and a job with nothing ready is in
-- neither and not in the pool at all.
CREATE VIEW pool_open AS
SELECT job.id AS job_id, job.z, job.x, job.y, job.bounty, job.target_version,
    CASE WHEN EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                        AND a.state = 'ready' AND a.op = 'train')
         THEN 'train' ELSE 'render' END AS phase
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

GRANT SELECT ON pool_open TO anon, player, admin;

-- One job as the panel reads it: db/0132's row, plus the phase and the last
-- few things that happened to the tile (db/0143), because a card that cannot
-- say why a tile is stuck is the panel this replaces.
CREATE FUNCTION pool_row(p_job bigint, p_lon double precision DEFAULT null,
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

-- A page of the pool: how many there are of this kind, and the ones on this
-- page. Ordered the way it is cut (db/0142): pay, then how near, then age.
CREATE FUNCTION pool_page(p_lon double precision DEFAULT null,
                          p_lat double precision DEFAULT null,
                          p_phase text DEFAULT null,
                          p_limit int DEFAULT 12,
                          p_offset int DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    out jsonb;
BEGIN
    PERFORM expire_claims();
    SELECT jsonb_build_object(
        'total', (SELECT count(*) FROM pool_open p
                  WHERE p_phase IS null OR p.phase = p_phase),
        'render', (SELECT count(*) FROM pool_open p WHERE p.phase = 'render'),
        'train', (SELECT count(*) FROM pool_open p WHERE p.phase = 'train'),
        'offset', greatest(p_offset, 0),
        'rows', coalesce(jsonb_agg(r.row ORDER BY r.seq), '[]'::jsonb))
    INTO out
    FROM (
        SELECT row_number() OVER () AS seq, pool_row(p.job_id, p_lon, p_lat) AS row
        FROM (
            SELECT p2.job_id FROM pool_open p2
            WHERE p_phase IS null OR p2.phase = p_phase
            ORDER BY p2.bounty DESC,
                CASE WHEN p_lon IS null THEN 0 ELSE
                    st_distance(st_centroid(tile_bbox(p2.z, p2.x, p2.y))::geography,
                        st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography)
                END ASC,
                p2.job_id ASC
            LIMIT greatest(p_limit, 0) OFFSET greatest(p_offset, 0)) AS p) AS r;
    RETURN out;
END
$$;

CREATE FUNCTION api.pool_page(lon double precision DEFAULT null,
                              lat double precision DEFAULT null,
                              phase text DEFAULT null,
                              "limit" int DEFAULT 12,
                              "offset" int DEFAULT 0) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$
SELECT public.pool_page(lon, lat, phase, "limit", "offset")
$$;

GRANT EXECUTE ON FUNCTION api.pool_page(double precision, double precision,
    text, int, int) TO anon, player, admin;
