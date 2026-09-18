-- 0152_thepoolsortsandsayswhichkind.sql — the redo buttons are allowed to
-- run, the pool has the kinds a person actually sorts by, and it sorts.
--
-- First, the bug: `api.redo_renders` and its two bulk cousins are plain SQL
-- wrappers, so they run as whoever called them, and db/0147 and db/0149
-- revoked the underlying functions from PUBLIC without granting them to
-- anybody. Every press answered "permission denied for function
-- redo_renders". The functions do their own authorising — they are SECURITY
-- DEFINER and check is_area_writer or admin — so the grant is the fix, not a
-- loosening of anything.
GRANT EXECUTE ON FUNCTION redo_renders(bigint) TO player, admin;
GRANT EXECUTE ON FUNCTION redo_land_renders(uuid) TO player, admin;
GRANT EXECUTE ON FUNCTION redo_ground_renders() TO admin;

-- db/0146's pool_open, with the third kind and whose it is. A job is
-- `train` when the next thing anybody can take is the training run,
-- `publish` when it is the packing or the merge — the cheap end, no GPU — and
-- `render` when it is the ground or the frames. `mine` is the caller's own:
-- ground they could drop or retry (may_retry_job, db/0102).
-- Replaced rather than created-or-replaced: a view's existing columns cannot
-- be reordered, and `mine` goes after them for that reason. pool_row and
-- kind_of read it by name, so the order is nobody's business but this.
DROP VIEW IF EXISTS pool_open CASCADE;
CREATE VIEW pool_open AS
SELECT job.id AS job_id, job.z, job.x, job.y, job.bounty, job.target_version,
    CASE
        WHEN EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                       AND a.state = 'ready' AND a.op = 'train') THEN 'train'
        WHEN EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                       AND a.state = 'ready' AND a.op IN ('sog', 'merge')) THEN 'publish'
        ELSE 'render' END AS phase,
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

GRANT SELECT ON pool_open TO anon, player, admin;

-- db/0146's pool_row, unchanged: the CASCADE above took it with the view.
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

-- db/0146's pool_page: `p_phase` is one of the three kinds, or 'mine' for the
-- caller's own ground, or null for all of them; `p_sort` is 'near' or 'pay'.
-- Nearest is what somebody is waiting to walk on and best pay is what a
-- stranger's tab is looking for, and the cut has to happen on whichever it
-- is — sorting a page that was chosen the other way is db/0142 again.
CREATE OR REPLACE FUNCTION pool_page(p_lon double precision DEFAULT null,
                                     p_lat double precision DEFAULT null,
                                     p_phase text DEFAULT null,
                                     p_limit int DEFAULT 12,
                                     p_offset int DEFAULT 0,
                                     p_sort text DEFAULT 'near') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    out jsonb;
    pay boolean := p_sort = 'pay';
BEGIN
    PERFORM expire_claims();
    SELECT jsonb_build_object(
        'total', (SELECT count(*) FROM pool_open p WHERE kind_of(p, p_phase)),
        'render', (SELECT count(*) FROM pool_open p WHERE p.phase = 'render'),
        'train', (SELECT count(*) FROM pool_open p WHERE p.phase = 'train'),
        'publish', (SELECT count(*) FROM pool_open p WHERE p.phase = 'publish'),
        'mine', (SELECT count(*) FROM pool_open p WHERE p.mine),
        'all', (SELECT count(*) FROM pool_open),
        'offset', greatest(p_offset, 0),
        'sort', coalesce(p_sort, 'near'),
        'rows', coalesce(jsonb_agg(r.row ORDER BY r.seq), '[]'::jsonb))
    INTO out
    FROM (
        SELECT row_number() OVER () AS seq, pool_row(p.job_id, p_lon, p_lat) AS row
        FROM (
            SELECT p2.job_id FROM pool_open p2
            WHERE kind_of(p2, p_phase)
            ORDER BY
                CASE WHEN pay THEN p2.bounty ELSE 0 END DESC,
                CASE WHEN p_lon IS null THEN 0 ELSE
                    st_distance(st_centroid(tile_bbox(p2.z, p2.x, p2.y))::geography,
                        st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography)
                END ASC,
                p2.bounty DESC,
                p2.job_id ASC
            LIMIT greatest(p_limit, 0) OFFSET greatest(p_offset, 0)) AS p) AS r;
    RETURN out;
END
$$;

-- Which rows a tab is asking for. Written once because the count and the page
-- must agree: a total that counts something the page does not show is a pager
-- that walks off the end.
CREATE OR REPLACE FUNCTION kind_of(p pool_open, p_phase text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT p_phase IS null OR p_phase = 'all'
    OR (p_phase = 'mine' AND (p).mine)
    OR (p).phase = p_phase;
$$;

GRANT EXECUTE ON FUNCTION kind_of(pool_open, text) TO anon, player, admin;

-- The five-argument one goes: a sixth parameter with a default does not
-- replace it, it sits beside it, and then every five-argument call is
-- ambiguous. Nothing outside this file ever called it without a sort.
DROP FUNCTION IF EXISTS api.pool_page(double precision, double precision, text, int, int);
DROP FUNCTION IF EXISTS pool_page(double precision, double precision, text, int, int);
CREATE OR REPLACE FUNCTION api.pool_page(lon double precision DEFAULT null,
                              lat double precision DEFAULT null,
                              phase text DEFAULT null,
                              "limit" int DEFAULT 12,
                              "offset" int DEFAULT 0,
                              sort text DEFAULT 'near') RETURNS jsonb
LANGUAGE sql VOLATILE AS $$
SELECT public.pool_page(lon, lat, phase, "limit", "offset", sort)
$$;

GRANT EXECUTE ON FUNCTION api.pool_page(double precision, double precision,
    text, int, int, text) TO anon, player, admin;
