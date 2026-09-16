-- 0116_thetrainerlooksattheframesagain.sql — back to the configuration that
-- ran, exactly.
--
-- The trainer ran for a day on this binary. Then, in one session, it stopped
-- at startup with "Failed to map buffer: BufferAsyncError" inside CubeCL's
-- autotune timing — and the atoms say when: every one built with the trainer
-- at the frames' own 1024 px got to its first refinement; every one built
-- with the trainer told 512 or 384 (db/0113, db/0115) died before step one.
-- A max-resolution below the frame size makes brush resize the views on the
-- GPU as it loads them. That is a kernel it had never run here, its autotune
-- benchmarks a kernel the first time it sees it, and the benchmark's own
-- timing readback is what this card cannot do. Same size as the frames, no
-- resize, no benchmark, and the run that worked is the run again.
--
-- So every number the trainer reads goes back to the last one it ran with:
-- the frames' size, half the budget seeded, 400 steps, the budget of
-- db/0074, and the splats written as brush made them (scale 1 — db/0112's
-- widening stays available, and off). The one thing kept from the session is
-- train-v5, whose differences at these settings are checks, not behaviour.
-- From here one number moves at a time, with a finished tile behind each.

-- db/0074's tile_budget, as it was.
CREATE OR REPLACE FUNCTION tile_budget(z int) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE z
    WHEN 18 THEN 2000000 WHEN 16 THEN 600000 WHEN 14 THEN 800000
    WHEN 12 THEN 900000 WHEN 10 THEN 1000000 WHEN 8 THEN 1200000
    ELSE 1500000 END::bigint;
$$;

-- db/0115's build_dag, with the trainer at the frames' size and every other
-- number where db/0104 had it.
CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v1' END;
    base   jsonb;
    asm    bigint;
    frames bigint [] := '{}';
    trn    bigint;
    mrg    bigint;
    views  int := camera_views(a_z);
    chunk  int := frame_chunk();
    i      int;
    budget bigint := tile_budget(a_z);
    px     int := 1024;
    how    jsonb := frame_renderer();
BEGIN
    IF a_z >= 14 THEN
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        asm := new_atom(a_job, 'assemble', 'assemble-v4', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, '{}');
        i := 0;
        WHILE i < views LOOP
            frames := frames || new_atom(a_job, 'frame', 'frame-v6',
                jsonb_build_object('assemble', asm, 'snapshot', snap),
                jsonb_build_object('camera_set', cams, 'size', px,
                    'from', i, 'to', least(i + chunk, views)) || how, 0, ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v5',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', 400,
                'size', px,
                'camera_set', cams,
                -- Of the budget, seeded on the surface: what is left is what
                -- brush grows where the frames say the picture is wrong.
                'seed_share', 0.5,
                -- How much wider every trained splat is written than the
                -- trainer settled on. Turn this up if the ground still shows
                -- through between them.
                'scale', 1,
                'needs_webgpu', true,
                'min_buffer_mb', ceil(96::numeric * budget / 1048576)), 0, frames);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
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
