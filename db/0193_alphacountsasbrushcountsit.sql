-- 0193_alphacountsasbrushcountsit.sql — train-v21: db/0192's
-- match-alpha-weight 0.5 undone.
--
-- Weighting the frames' alpha five times brush's own 0.1 was to close a slight
-- translucency; what it did was make splats big and blurry again. The alpha
-- term rewards cover, and the cheapest cover is a wider splat. brush's own
-- weight is back; the skirt db/0192 added (dataset-v6) stays.
--
-- train-v21 is train-v20's code; the version moves so every open job is
-- rebuilt (atom_current reads the version, not the params).
CREATE OR REPLACE FUNCTION algo_current(p_op text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE p_op
    WHEN 'dataset' THEN 'dataset-v6'
    WHEN 'train' THEN 'train-v21'
    WHEN 'merge' THEN 'merge-v1'
    WHEN 'sog' THEN 'sog-v3'
    WHEN 'verify' THEN 'verify-v1' END;
$$;

-- db/0192's build_dag at train-v21, without match-alpha-weight.
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
        -- holds the frame count to. The ground is cut down to z16.
        ds := new_atom(a_job, 'dataset', 'dataset-v6', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget, 'camera_set', cams, 'size', px,
                               'views', views,
                               'dem_deeper', greatest(1, least(2, 16 - a_z)))
            || how, 0, '{}');
        trn := new_atom(a_job, 'train', 'train-v21',
            jsonb_build_object('dataset', ds),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                -- Where brush's own app starts: three tenths of the budget
                -- on the surface (db/0184), a tenth of the budget of that on
                -- a lattice across the ground (db/0186), two thirds of the
                -- allocated rest on the ground (db/0174), brush's own growth
                -- window, a refine every 100 steps (db/0188), and more growth
                -- than brush's own (db/0189).
                'seed_share', 0.3,
                'seed_grid', 0.1,
                'ground_floor', 0.66,
                'refine_every', 100,
                'scale', 1,
                'brush', jsonb_build_object(
                    'growth-grad-threshold', 0.0015,
                    'growth-select-fraction', 0.4),
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

SELECT refresh_stale_jobs();
