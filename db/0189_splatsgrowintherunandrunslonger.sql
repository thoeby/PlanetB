-- 0189_splatsgrowintherunandrunslonger.sql — splats grow in the run, not after
-- it, and a tile trains for 4000 steps.
--
-- The background shows between trained splats. Widening them after the run
-- (client/atoms/train.js `widen`, the `scale` param) stretches splats brush
-- fitted at their own size, so their colours smear into their neighbours; it
-- stays at 1. Instead brush is let off the two things that hold a splat back
-- while it trains (crates/brush-train config.rs at 48ca31c):
--   scale-decay 0.002 -> 0      a pull on every splat's size towards zero
--   opac-decay  0.004 -> 0.002  a pull on every splat's opacity towards zero
-- and grows more of them where the frames are not yet matched:
--   growth-grad-threshold 0.0025 -> 0.0015, growth-select-fraction 0.25 -> 0.4.
-- The biggest a splat may get is still brush's split-at-screen-size.
-- 2400 steps -> 4000: the second half of a run is where splats get small, and
-- since brush at 48ca31c a step is cheap enough to buy.
--
-- Invariant 2: iters and the knobs travel in the train atom's params.
-- train-v18 is the trainer that hands `brush` on (client/lib/brush.js
-- configFor); the version moving is also what rebuilds every open job.
CREATE OR REPLACE FUNCTION world_default(p_key text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE p_key
    WHEN 'budget_scale' THEN '1'
    WHEN 'iters' THEN '4000'
    WHEN 'frame_px' THEN '1280'
    WHEN 'lease' THEN '00:05:00'
    WHEN 'lease_train' THEN '00:30:00' END;
$$;

CREATE OR REPLACE FUNCTION algo_current(p_op text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE p_op
    WHEN 'dataset' THEN 'dataset-v5'
    WHEN 'train' THEN 'train-v18'
    WHEN 'merge' THEN 'merge-v1'
    WHEN 'sog' THEN 'sog-v3'
    WHEN 'verify' THEN 'verify-v1' END;
$$;

-- db/0188's build_dag at train-v18, with brush's knobs.
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
        trn := new_atom(a_job, 'train', 'train-v18',
            jsonb_build_object('dataset', ds),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                -- Where brush's own app starts: three tenths of the budget
                -- on the surface (db/0184), a tenth of the budget of that on
                -- a lattice across the ground (db/0186), two thirds of the
                -- allocated rest on the ground (db/0174), brush's own growth
                -- window, a refine every 100 steps (db/0188), and splats let
                -- grow in the run rather than widened after it (header).
                'seed_share', 0.3,
                'seed_grid', 0.1,
                'ground_floor', 0.66,
                'refine_every', 100,
                'scale', 1,
                'brush', jsonb_build_object(
                    'scale-decay', 0,
                    'opac-decay', 0.002,
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
