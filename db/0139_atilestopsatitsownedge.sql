-- 0139_atilestopsatitsownedge.sql — a trained tile is not allowed a halo, so
-- the server stops refusing it.
--
-- A finished z14 run was thrown away by `bbox_fits` and the tab trained it
-- again, a quarter of an hour a time, three times, saying only "ready".
--
-- Two windows disagreed. `assemble` clips its meshes to the tile plus 8 m
-- (client/atoms/assemble.js CLIP_M) and `bbox_fits` accepts splats out to the
-- tile plus 10 m (db/0015_structural.sql) — two metres of ground to spare, at
-- every zoom, because both are fixed metres. But `train` kept every splat
-- brush had moved to within MARGIN = 15 % of the tile of the seed: 254 m at
-- z14, against a limit of 856.6 m. One splat of six hundred thousand drifting
-- two metres past the mesh edge widened `result.bbox` and the whole run was
-- refused — which, on a tile seeded to its own clipped edge, is not bad luck
-- but the ordinary case.
--
-- client/atoms/train.js now pads the keep-window by a metre across the ground
-- (EDGE_PAD_M) and by a share of the seed's span only in height, where the
-- rule is deliberately loose. Nothing about the rule changes: the tile that
-- was always meant to be inside it now is.
--
-- And client/js/work.js says so: a submit that comes back anything but
-- 'verified' is now counted as a failure and logged with the rule that
-- refused it, instead of being reported as work done.
--
-- Invariant 2: the window a splat is kept by is part of what the trainer is,
-- so train-v10.
--
-- db/0138's build_dag at train-v10.
CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v2' END;
    leaf   boolean := is_leaf_tile(a_z, a_x, a_y);
    base   jsonb;
    asm    bigint;
    frames bigint [] := '{}';
    trn    bigint;
    mrg    bigint;
    views  int := coalesce(nullif(camera_views(a_z), 0), camera_views(14));
    chunk  int := frame_chunk();
    i      int;
    budget bigint := job_budget(a_z);
    px     int := frame_px();
    how    jsonb := frame_renderer();
BEGIN
    IF leaf THEN
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        asm := new_atom(a_job, 'assemble', 'assemble-v5', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, '{}');
        i := 0;
        WHILE i < views LOOP
            frames := frames || new_atom(a_job, 'frame', 'frame-v10',
                jsonb_build_object('assemble', asm, 'snapshot', snap),
                jsonb_build_object('camera_set', cams, 'size', px,
                    'from', i, 'to', least(i + chunk, views)) || how, 0, ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v10',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                -- Of the budget, seeded on the surface: small, because what
                -- is left is what brush grows where the frames say the
                -- picture is wrong, and that is the part worth having.
                'seed_share', 0.0375,
                -- How much wider every trained splat is written than the
                -- trainer settled on. Turn this up if the ground still shows
                -- through between them — but a tile that is short of splats
                -- is not one this can cover.
                'scale', 1.3,
                -- How often brush looks for splats to split. Thirty-six
                -- passes in the growth window, which is what takes a seed
                -- this size to the budget.
                'refine_every', 20,
                'needs_webgpu', true,
                'min_buffer_mb', ceil(96::numeric * budget / 1048576)), 0, frames);
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
