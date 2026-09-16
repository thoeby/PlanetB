-- 0115_smallenoughtofinish.sql — a tile small enough that the card gets to
-- the end of it.
--
-- The driver went down with it: no panic, no log, the GPU process restarted.
-- That is Windows' timeout detection and recovery, which resets the display
-- driver when one dispatch does not return inside about two seconds. At 630 ms
-- a step this card was already within a factor of three of that line, and a
-- refinement, or one of autotune's heavier candidates, is what crosses it.
-- Nothing in a browser can catch it: the device is gone before anything of
-- ours runs.
--
-- Nothing here is a quality target. It is the smallest tile that exercises the
-- whole path — assemble, frame, train, sog, verify, publish — so there is a
-- finished tile to compare against, and every dispatch in it is small enough
-- that the driver is not asked to sit for two seconds:
--
--   budget   200k splats on a trained tile, a quarter of what it was in db/0074
--   seed     a quarter of that, 50k, as db/0114 has it
--   iters    400, as db/0105 had it: the run that reached the end
--   size     384 px, down from 1024 in db/0104 and 512 in db/0113
--
-- Each of the four goes back up on its own, with a run behind it, and the
-- first one that takes the driver down is the one that was too big. On the
-- machine itself, `TdrDelay` (HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers,
-- seconds, 2 by default) is the other half: a compute job that is meant to
-- take minutes wants more than two seconds of patience from the operating
-- system, and every long-running GPU tool on Windows asks for it.

-- db/0111's tile_budget, quartered again where a tile is trained.
CREATE OR REPLACE FUNCTION tile_budget(z int) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT CASE z
    WHEN 18 THEN 500000 WHEN 16 THEN 150000 WHEN 14 THEN 200000
    WHEN 12 THEN 900000 WHEN 10 THEN 1000000 WHEN 8 THEN 1200000
    ELSE 1500000 END::bigint;
$$;

-- db/0114's build_dag, at 400 steps of 384 px.
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
    -- What the trainer looks at. The frames are drawn at px and brush
    -- downsamples to this, so the picture keeps its detail and a step costs a
    -- quarter of what a 1024 px step costs.
    tpx    int := 384;
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
                'size', tpx,
                'camera_set', cams,
                -- Of the budget, seeded on the surface: what is left is what
                -- brush grows where the frames say the picture is wrong.
                'seed_share', 0.25,
                -- How much wider every trained splat is written than the
                -- trainer settled on. Turn this up if the ground still shows
                -- through between them.
                'scale', 2,
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
