-- 0190_brushdecaysagainover2400steps.sql — db/0189 half undone.
--
-- 4000 steps bought nothing the first 2400 had not: the holes a tile ends
-- with are there early, and brush's own app, handed the same folder, closes
-- them in seconds. So a run is 2400 steps again, and brush's scale-decay and
-- opac-decay are its own again (db/0189 had them at 0 and 0.002, for no
-- visible difference). The growth db/0189 asked for stays:
-- growth-grad-threshold 0.0015, growth-select-fraction 0.4.
--
-- train-v19 is train-v18's code; the version moves so every open job is
-- rebuilt (atom_current reads the version, not the params).
CREATE OR REPLACE FUNCTION world_default(p_key text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE p_key
    WHEN 'budget_scale' THEN '1'
    WHEN 'iters' THEN '2400'
    WHEN 'frame_px' THEN '1280'
    WHEN 'lease' THEN '00:05:00'
    WHEN 'lease_train' THEN '00:30:00' END;
$$;

CREATE OR REPLACE FUNCTION algo_current(p_op text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE p_op
    WHEN 'dataset' THEN 'dataset-v5'
    WHEN 'train' THEN 'train-v19'
    WHEN 'merge' THEN 'merge-v1'
    WHEN 'sog' THEN 'sog-v3'
    WHEN 'verify' THEN 'verify-v1' END;
$$;

-- db/0189's build_dag at train-v19: brush's decays back, its growth kept.
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
        ds := new_atom(a_job, 'dataset', 'dataset-v5', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget, 'camera_set', cams, 'size', px,
                               'views', views,
                               'dem_deeper', greatest(1, least(2, 16 - a_z)))
            || how, 0, '{}');
        trn := new_atom(a_job, 'train', 'train-v19',
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
