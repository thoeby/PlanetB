-- 0095_thetrainerisbrush.sql — the trainer is brush.
--
-- `train-v3` (client/atoms/train.js, client/lib/brush.js) hands the frames,
-- their poses and the full-budget surface seed to brush — a 3D gaussian
-- splatting trainer built by people who do nothing else, as WebAssembly on
-- WebGPU — and reads the splats back. The trainer written here for train-v1
-- and v2 had never run on a real GPU. Same DAG, same inputs, same params;
-- the algo_version is what says the bytes will differ (Invariant 2), and the
-- browser tab is still where every one of them is computed (Invariant 9).
CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v1' END;
    leaf   boolean := is_leaf_tile(a_z, a_x, a_y);
    base   jsonb;
    asm    bigint;
    frames bigint [] := '{}';
    trn    bigint;
    smp    bigint;
    mrg    bigint;
    views  int := camera_views(a_z);
    chunk  int := frame_chunk();
    i      int;
    budget bigint := tile_budget(a_z);
BEGIN
    IF leaf THEN
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        asm := new_atom(a_job, 'assemble', 'assemble-v2', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, '{}');
    END IF;

    IF a_z >= 16 THEN
        i := 0;
        WHILE i < views LOOP
            frames := frames || new_atom(a_job, 'frame', 'frame-v2',
                jsonb_build_object('assemble', asm, 'snapshot', snap),
                jsonb_build_object('camera_set', cams, 'samples', 64, 'bounces', 3,
                    'from', i, 'to', least(i + chunk, views)), 0, ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v3',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', CASE WHEN a_z = 18 THEN 2000 ELSE 1500 END,
                'size', CASE WHEN a_z = 18 THEN 1024 ELSE 512 END,
                'camera_set', cams,
                'needs_webgpu', true,
                -- What brush holds per splat is smaller than the trainer
                -- before it did, but the frames are decoded on the device
                -- too; 96 bytes a splat stays the honest ask.
                'min_buffer_mb', ceil(96::numeric * budget / 1048576)), 0, frames);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
    ELSIF leaf THEN
        smp := new_atom(a_job, 'sample', 'sample-v3',
            jsonb_build_object('assemble', asm, 'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, ARRAY[asm]);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', smp),
            jsonb_build_object('budget', budget), 0, ARRAY[smp]);
    ELSE
        mrg := new_atom(a_job, 'merge', 'merge-v1',
            jsonb_build_object('children', child_sogs(a_z, a_x, a_y),
                               'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'voxel', 0.05, 'budget', budget), 0, '{}');
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', mrg),
            jsonb_build_object('budget', budget), 0, ARRAY[mrg]);
    END IF;
END
$$;
