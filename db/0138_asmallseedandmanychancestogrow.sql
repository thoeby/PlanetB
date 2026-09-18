-- 0138_asmallseedandmanychancestogrow.sql — the trainer decides where the
-- splats go, not the surface sampler.
--
-- db/0133 put the seed back to half the budget because a fortieth of it never
-- grew: brush grows by about a tenth of what it holds at each refine, and at
-- its own interval a 1 200-step run held five of them — 22 500 seeded came
-- back as 37 000. Half the budget reached the budget, which was the point, but
-- it reached it by starting there: 300 000 of a z16 tile's 600 000 are placed
-- by client/lib/sampling.js on a uniform walk of the surface, before a single
-- frame has been looked at. The trainer then has one doubling's worth of say
-- over a tile it was supposed to author. A forest and a car park are seeded
-- alike.
--
-- What decides whether a seed reaches the budget is the number of refine
-- passes, not the size of the seed, because growth is a fraction of the
-- current count. The growth window is 60 % of the run (client/lib/brush.js
-- configFor), so 720 steps:
--
--     refine_every 50 -> 14 passes -> 1.104^14 =  4.2x  (300 000 -> capped)
--     refine_every 20 -> 36 passes -> 1.104^36 = 33.3x  ( 22 500 -> capped)
--
-- The 1.104 is measured, not assumed: the 22 500 -> 37 000 run that started
-- all this was five passes (37000/22500)^(1/5). So a fortieth of the budget
-- reaches the cap with a quarter to spare, in the same 1 200 steps, on a run
-- that is cheaper for most of its length because it carries fewer splats —
-- and every splat past the seed is one brush put where the frames said the
-- picture was wrong.
--
-- The cost is a noisier split decision: each pass now weighs gradients
-- accumulated over twenty steps instead of a hundred and fifty. It is a
-- param, and 30 is the middle if the tiles come back mottled.
--
-- Invariant 2: seed_share and refine_every travel in the atom's params, so
-- every tile built this way is a different atom from the one before it. The
-- trainer's own defaults move with them, so train-v9.
--
-- db/0137's build_dag with the seed small again and the refines frequent.
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
        trn := new_atom(a_job, 'train', 'train-v9',
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
