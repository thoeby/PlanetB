-- 0188_thegroundisfinerandtheframesbigger.sql — more of the survey reaches
-- the trainer, and the trainer looks at it more closely.
--
-- * The ground of a z14 tile is cut from z16: sixteen cuts, a 2048 raster
--   (client/lib/geo.js loadDemDeeper), over a mesh of 2049 vertices across
--   (client/atoms/assemble.js MAX_GRID, assemble-v14) — a 0.8 m grid where
--   it was 1.6 m. A z16 tile stays one zoom deeper: z17 is already finer
--   than the half-metre survey. A descendant the store cannot cut now drops
--   the ground one zoom at a time, not straight back to the tile's own cut.
-- * Frames are drawn and trained at 1280 px, not 1024.
-- * brush refines every 100 steps rather than its own 200: twice the
--   chances for a large splat to split within the 2400-step run.
--
-- dataset-v5 carries the ground and the size. Invariant 2: dem_deeper and
-- refine_every travel in the atoms' params, so every open job is rebuilt.
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
    WHEN 'train' THEN 'train-v17'
    WHEN 'merge' THEN 'merge-v1'
    WHEN 'sog' THEN 'sog-v3'
    WHEN 'verify' THEN 'verify-v1' END;
$$;

-- db/0187's build_dag at dataset-v5, with dem_deeper and refine_every.
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
        trn := new_atom(a_job, 'train', 'train-v17',
            jsonb_build_object('dataset', ds),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                -- Where brush's own app starts: three tenths of the budget
                -- on the surface (db/0184), a tenth of the budget of that on
                -- a lattice across the ground (db/0186), two thirds of the
                -- allocated rest on the ground (db/0174), brush's own growth
                -- window, and a refine every 100 steps (see the header).
                'seed_share', 0.3,
                'seed_grid', 0.1,
                'ground_floor', 0.66,
                'refine_every', 100,
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
