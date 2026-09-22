-- 0187_thegroundiscutdeeperandhasgrain.sql — the ground is cut one zoom
-- deeper than the tile, and the frames draw a grain on it.
--
-- A cut is 512 samples across at any zoom, so a z14 tile built from its own
-- cut is a 3.3 m grid over a half-metre survey, and every fold of hillside
-- smaller than that was gone before the trainer saw a frame: the operator's
-- words for the result were a 1990s game map. assemble-v13 builds the ground
-- from the four cuts one zoom deeper (`dem_deeper`, client/lib/geo.js
-- loadDemDeeper) over a mesh of 1025 vertices across, and falls back to the
-- tile's own cut where the store cannot cut a descendant. And the ground is
-- drawn with a grain (client/lib/raster.js grainTexture): a tileable
-- greyscale by world position, three octaves down to forty centimetres,
-- within a seventh of the colour — finer than any mesh, and something a
-- trainer can hold a splat still against, where flat colour let every
-- position along the slope reproduce the frame equally well.
--
-- dataset-v4 carries both; the trainer is unchanged (train-v17) and reads
-- the new dataset by its hash. Every open job draws its dataset again.
CREATE OR REPLACE FUNCTION algo_current(p_op text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE p_op
    WHEN 'dataset' THEN 'dataset-v4'
    WHEN 'train' THEN 'train-v17'
    WHEN 'merge' THEN 'merge-v1'
    WHEN 'sog' THEN 'sog-v3'
    WHEN 'verify' THEN 'verify-v1' END;
$$;

-- db/0186's build_dag at dataset-v4.
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
        ds := new_atom(a_job, 'dataset', 'dataset-v4', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget, 'camera_set', cams, 'size', px,
                               'views', views) || how, 0, '{}');
        trn := new_atom(a_job, 'train', 'train-v17',
            jsonb_build_object('dataset', ds),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                -- Where brush's own app starts: three tenths of the budget
                -- on the surface (db/0184), a tenth of the budget of that on
                -- a lattice across the ground (see the header), two thirds
                -- of the allocated rest on the ground (db/0174), and brush's
                -- own refine interval and growth window — no refine_every.
                'seed_share', 0.3,
                'seed_grid', 0.1,
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
