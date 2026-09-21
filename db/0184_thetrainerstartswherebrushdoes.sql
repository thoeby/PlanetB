-- 0184_thetrainerstartswherebrushdoes.sql — the trainer starts where brush's
-- own app starts.
--
-- The operator handed one of our datasets (tools/dataset.mjs, everything
-- the trainer sees) to brush's own app: in a minute, at 3 365 steps, the tile
-- was readable from every side. Ours, from the same frames, was blobs. The
-- app started from the assemble's init.ply — three tenths of the budget —
-- with brush's own refine interval and growth window; ours seeded a tenth,
-- refined every thirty steps and stopped growing at 60 % of 2 400. Those
-- three numbers were tuned for a 1 200-step run (db/0133, db/0138) and are
-- what was wrong. train-v16 (client/atoms/train.js, client/lib/brush.js)
-- seeds three tenths and leaves the schedule to brush.
--
-- Invariant 2: a changed trainer is a new name, so every open job trains
-- again; the datasets are untouched and reused by their hash.
CREATE OR REPLACE FUNCTION algo_current(p_op text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE p_op
    WHEN 'dataset' THEN 'dataset-v1'
    WHEN 'train' THEN 'train-v16'
    WHEN 'merge' THEN 'merge-v1'
    WHEN 'sog' THEN 'sog-v3'
    WHEN 'verify' THEN 'verify-v1' END;
$$;

-- db/0183's build_dag at train-v16.
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
        trn := new_atom(a_job, 'train', 'train-v16',
            jsonb_build_object('dataset', ds),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                -- Where brush's own app starts: three tenths of the budget
                -- on the surface, two thirds of that on the ground (db/0174),
                -- and brush's own refine interval and growth window — no
                -- refine_every here (db/0184).
                'seed_share', 0.3,
                'ground_floor', 0.66,
                'scale', 1,
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
