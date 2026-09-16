-- 0111_fewersplatsallowedtobebigger.sql — fewer splats, each allowed to be as
-- big as the ground it stands on, and the steps to get there.
--
-- The tiles come out with holes everywhere, and the card is busy a quarter of
-- a compile. Both are the same run: db/0105 cut training to 400 steps, and at
-- 400 steps brush's own caps decide the picture. A splat is split as soon as
-- it projects larger than brush's screen-size threshold, and its extent moves
-- at a learning rate written for tens of thousands of steps, so it is made
-- smaller long before it ever covers the spacing between its neighbours, and
-- the background shows through in between. Meanwhile the fixed costs of a run
-- — the frames decoded, the seed placed, the kernels tuned, the splats read
-- back — do not shrink with the step count, so at 400 steps they are most of
-- the wall clock and the GPU idles through them.
--
-- So: half the splats on a trained tile, three times the steps, and each splat
-- allowed to grow (client/atoms/train.js, `train-v4`). A sample's extent is
-- its triangle's spacing times a spread (client/lib/sampling.js), and spacing
-- is the square root of area over count — so halving the budget makes every
-- seed splat larger by itself, covering the same ground with fewer, wider
-- splats. Which is what a tile of this world is: ground seen from the air,
-- not a scanned object.
--
-- Costs, per z14 tile: 400k splats instead of 800k (the ply, the sog and the
-- tab's memory all halve — min_buffer_mb with them), 1200 steps instead of
-- 400. Roughly the wall clock of today's run, three times the optimisation in
-- it, and the card busy for most of it.

-- db/0074's tile_budget, halved where a tile is trained (z14 and finer). The
-- merged tiles below are made of these, and follow.
CREATE OR REPLACE FUNCTION tile_budget(z int) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE z
    WHEN 18 THEN 1000000 WHEN 16 THEN 300000 WHEN 14 THEN 400000
    WHEN 12 THEN 900000 WHEN 10 THEN 1000000 WHEN 8 THEN 1200000
    ELSE 1500000 END::bigint;
$$;

-- db/0107's build_dag: train-v4, 1200 steps, and the three numbers the trainer
-- reads for how much of the budget to seed and how far a splat may grow. They
-- are params, so they are part of the atom's hash (Invariant 2) and can be
-- tuned from here without another algo_version.
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
        trn := new_atom(a_job, 'train', 'train-v4',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', 1200,
                'size', px,
                'camera_set', cams,
                -- Of the budget, seeded on the surface: what is left is what
                -- brush grows where the frames say the picture is wrong.
                'seed_share', 0.75,
                -- How much larger than brush proposes a splat may be before
                -- it is split, and how fast its extent may move: multiples of
                -- the vendored build's own numbers.
                'grow', 4,
                'lr_scale', 2,
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
