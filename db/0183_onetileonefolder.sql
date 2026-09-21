-- 0183_onetileonefolder.sql — one tile, one folder.
--
-- A tile's job was an assemble atom and three to six frame atoms of twenty
-- views each, then the trainer and the pack: eight folders in the store, and
-- the dataset the trainer learned from — frames, poses, seed — existed only
-- in a tab's private storage while brush ran. Nothing on disk was the
-- dataset, and eight pieces per tile were eight chances for the pool to
-- wedge.
--
-- `dataset` (client/atoms/dataset.js) assembles the tile, draws every view of
-- its camera set and writes one tar: the scene, the meshes, the seed, the
-- height and colliders, every frame and transforms.json. train-v15 reads it;
-- so does the pack, for the height and colliders it publishes beside the
-- sog. A leaf job is three atoms now: dataset, train, sog.
--
-- `assemble` and `frame` are retired: algo_current names no version for
-- them, so every open job that still has one is stale (db/0182 atom_current)
-- and is reopened by refresh_stale_jobs — once here, and on demand when a
-- tab asks (db/0179). Invariant 2 holds: nothing old is rewritten, new atoms
-- are new computations under new names.

ALTER TABLE artifact DROP CONSTRAINT artifact_kind_check;
ALTER TABLE artifact ADD CONSTRAINT artifact_kind_check CHECK (kind IN (
    'glb', 'thumb', 'dem', 'ortho', 'frames', 'init_ply', 'dataset',
    'ply', 'sog', 'height', 'colliders',
    'height_edit', 'cover', 'flow', 'material', 'plugin',
    'profile', 'collection', 'lod'));

-- db/0178's algo_current: dataset and train-v15; assemble and frame retired.
CREATE OR REPLACE FUNCTION algo_current(p_op text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE p_op
    WHEN 'dataset' THEN 'dataset-v1'
    WHEN 'train' THEN 'train-v15'
    WHEN 'merge' THEN 'merge-v1'
    WHEN 'sog' THEN 'sog-v3'
    WHEN 'verify' THEN 'verify-v1' END;
$$;

-- What submit_atom holds a dataset to: the assemble's rules (db/0015), and
-- every view of the set drawn.
INSERT INTO structural_rule (op, name, rule) VALUES
('dataset', 'bytes', '$3 > 0'),
('dataset', 'finite', '($2 ->> ''finite'')::boolean IS true'),
('dataset', 'budget',
 'coalesce(($2 ->> ''splat_count'')::bigint, 0) <= (($1).params ->> ''budget'')::bigint'),
('dataset', 'bbox', 'bbox_fits($1, $2)'),
('dataset', 'frames',
 'coalesce(($2 ->> ''frames'')::int, -1) = (($1).params ->> ''views'')::int');

-- db/0182's build_dag: a leaf is a dataset, a trainer and a pack.
CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := camera_set_current(a_z);
    leaf   boolean := is_leaf_tile(a_z, a_x, a_y);
    base   jsonb;
    ds     bigint;
    trn    bigint;
    mrg    bigint;
    views  int := coalesce(nullif(camera_views(a_z), 0), camera_views(14));
    budget bigint := job_budget(a_z);
    px     int := frame_px();
    how    jsonb := frame_renderer();
BEGIN
    IF leaf THEN
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        -- One tile, one folder: the assembled scene, every frame of the
        -- camera set and the seed, in one piece of work and one tar
        -- (client/atoms/dataset.js). `views` is what the structural rule
        -- holds the frame count to.
        ds := new_atom(a_job, 'dataset', 'dataset-v1', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget, 'camera_set', cams, 'size', px,
                               'views', views) || how, 0, '{}');
        trn := new_atom(a_job, 'train', 'train-v15',
            jsonb_build_object('dataset', ds),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                -- The trainer's numbers, as db/0174 set them and for the
                -- reasons written there.
                'seed_share', 0.1,
                'ground_floor', 0.66,
                'scale', 1,
                'refine_every', 30,
                'needs_webgpu', true,
                'min_buffer_mb', ceil(96::numeric * budget / 1048576)), 0, ARRAY[ds]);
        PERFORM new_atom(a_job, 'sog', 'sog-v3', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
    ELSE
        mrg := new_atom(a_job, 'merge', 'merge-v1',
            jsonb_build_object('children', child_sogs(a_z, a_x, a_y),
                               'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'voxel', 0.05, 'budget', budget), 0, '{}');
        PERFORM new_atom(a_job, 'sog', 'sog-v3', jsonb_build_object('ply', mrg),
            jsonb_build_object('budget', budget), 0, ARRAY[mrg]);
    END IF;
END
$$;

-- ---------------------------------------------- the pool, over the new shape

-- db/0153's pool_open, job_steps and pool_row, counting a dataset as the
-- render step and as the frames.
CREATE OR REPLACE VIEW pool_open AS
SELECT job.id AS job_id, job.z, job.x, job.y, job.bounty, job.target_version,
    CASE
        WHEN EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                       AND a.op IN ('dataset', 'assemble', 'frame')
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
        CASE a.op WHEN 'dataset' THEN 1 WHEN 'assemble' THEN 1 WHEN 'merge' THEN 1 WHEN 'frame' THEN 2
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
               WHERE a.job_id = p.job_id AND a.op IN ('dataset', 'frame')),
    'frames_done', (SELECT count(*) FROM atom a
                    WHERE a.job_id = p.job_id AND a.op IN ('dataset', 'frame')
                      AND a.state = 'verified'),
    'steps', job_steps(p.job_id),
    'may_retry', may_retry_job(p.job_id),
    'made', CASE
        WHEN EXISTS (SELECT 1 FROM atom a
                     WHERE a.job_id = p.job_id AND a.op = 'train') THEN 'trained'
        WHEN EXISTS (SELECT 1 FROM atom a
                     WHERE a.job_id = p.job_id AND a.op IN ('dataset', 'assemble')) THEN 'assembled'
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


-- db/0162's render_pool, the same.
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
            'opened_at', job.created_at, 'why', job.reason,
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
                             WHERE a.job_id = job.id AND a.op IN ('dataset', 'assemble')) THEN 'assembled'
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

-- ------------------------------------------- draw every frame again, now

-- db/0149's redo_renders: the dataset is drawn again, and everything after it.
CREATE OR REPLACE FUNCTION redo_renders(p_job bigint) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    j    job%rowtype;
    ds   bigint [];
    n    int := 0;
BEGIN
    SELECT * INTO j FROM job WHERE id = p_job FOR UPDATE;
    IF j.id IS null THEN
        RAISE EXCEPTION 'no such job %', p_job USING errcode = '23503';
    END IF;
    IF j.state <> 'open' THEN
        RAISE EXCEPTION 'job % is %, so its frames are not the world''s any more',
            p_job, j.state USING errcode = '23514';
    END IF;
    IF current_user_role() <> 'admin'
       AND NOT EXISTS (SELECT 1 FROM area
                       WHERE st_intersects(area.geom, tile_bbox(j.z, j.x, j.y))
                         AND is_area_writer(area.id)) THEN
        RAISE EXCEPTION 'that tile is not yours to render again' USING errcode = '42501';
    END IF;

    -- This job's dataset and frames, and the ones its training names — which
    -- may sit on another job's row after an adoption (db/0100 new_atom).
    SELECT coalesce(array_agg(DISTINCT a.id), '{}') INTO ds
    FROM atom a
    WHERE (a.job_id = p_job
           OR a.id = ANY (coalesce((SELECT t.deps FROM atom t
                                    WHERE t.job_id = p_job AND t.op = 'train'), '{}')))
      AND a.op IN ('dataset', 'frame');
    IF cardinality(ds) = 0 THEN
        RETURN 0;
    END IF;

    -- Every state may go to `failed` and `failed` may go to `ready` or
    -- `waiting`, and `verified` may go nowhere else (db/0005_state.sql), so
    -- both moves go through it rather than around the guard.
    UPDATE atom SET state = 'failed', worker_id = null, claimed_at = null,
        heartbeat_at = null
    WHERE (id = ANY (ds) OR (job_id = p_job AND op IN ('train', 'sog', 'verify')))
      AND state <> 'failed';
    UPDATE atom SET state = CASE WHEN cardinality(deps) = 0 THEN 'ready' ELSE 'waiting' END,
        attempts = 0, handed_back = 0, output_sha256 = null, result = null
    WHERE id = ANY (ds);
    GET DIAGNOSTICS n = ROW_COUNT;
    UPDATE atom SET state = 'waiting', attempts = 0, handed_back = 0,
        output_sha256 = null, result = null
    WHERE job_id = p_job AND op IN ('train', 'sog', 'verify');

    INSERT INTO tile_event (z, x, y, job_id, op, kind, detail)
    VALUES (j.z, j.x, j.y, j.id, 'dataset', 'handed_back',
            'the frames asked for again, and the training with them');
    PERFORM advance_atoms(p_job);
    RETURN n;
END
$$;

-- The jobs this world already has, in the old shape.
SELECT refresh_stale_jobs();
