-- 0186_theseedcoversthegroundinagrid.sql — a third of the seed is a lattice
-- across the ground, the ground is mottled, and the frames' alpha is read as
-- brush reads it.
--
-- db/0184 put the trainer where brush's own app starts: three tenths of the
-- budget, brush's own schedule. The tiles still came back with stretches of
-- hillside tens of metres across that no splat had landed on. The allocation
-- (client/lib/sampling.js allocate) is fair by area on average and a lottery
-- by triangle, and a trainer cannot move what is not there. So of the budget
-- a tenth (`seed_grid`, a third of the seed) is laid on a square lattice
-- across the ground before anything is allocated (gridSurfaces): one splat at
-- every lattice point that falls on a ground triangle, at that triangle's own
-- height, colour and normal, so no stretch of ground is more than a spacing
-- from one. The other two tenths are allocated as before, with the ground's
-- floor (db/0174).
--
-- The recipe is one function now (sampling.js seedOf): train-v17 starts from
-- it, assemble-v12 writes it as init.ply, tools/dataset.mjs puts it in the
-- folder for brush's app, and the dataset's transforms.json names it — so the
-- same seed is what every run of these frames starts from, wherever it runs.
--
-- Two more things the app did with the same folder that the trainer did not:
-- it read the frames' alpha as transparent (no mask file beside a frame), so
-- the void around a tile is trained towards nothing and holds the edge in;
-- the trainer said `masked`, which leaves the void out of the loss, and its
-- edges came back smeared outward. train-v17 leaves the alpha to brush
-- (client/lib/brush.js configFor). And the ground it learned from was one
-- colour over a whole hillside, which gives a trainer nothing to hold a splat
-- in place with along the slope: assemble-v12 mottles the ground's colour —
-- two octaves of value noise, six and twenty-four metres, never more than a
-- seventh either way, the one field across a tile's edge into its neighbour,
-- and off where an orthophoto carries its own picture (client/lib/terrain.js
-- mottleAt).
--
-- Invariant 2: different bytes, different names. dataset-v3 (assemble-v12
-- underneath) and train-v17; every open job draws its dataset and trains
-- again, and refresh_stale_jobs reopens them.
CREATE OR REPLACE FUNCTION algo_current(p_op text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE p_op
    WHEN 'dataset' THEN 'dataset-v3'
    WHEN 'train' THEN 'train-v17'
    WHEN 'merge' THEN 'merge-v1'
    WHEN 'sog' THEN 'sog-v3'
    WHEN 'verify' THEN 'verify-v1' END;
$$;

-- db/0185's build_dag at dataset-v3 and train-v17, with the lattice share.
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
        ds := new_atom(a_job, 'dataset', 'dataset-v3', base,
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
