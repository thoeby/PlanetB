-- 0145_thegrowththerunactuallyhas.sql — the seed is sized to the growth the
-- run delivers, not to the growth it ought to.
--
-- db/0138 set the seed to a fortieth of the budget and `refine_every` to 20,
-- on 10.4 % growth a pass: 36 passes, 33x, budget reached. A z14 tile came
-- back with 134 000 splats of 600 000 — 5.96x, so 5.1 % a pass, half what was
-- assumed.
--
-- The 10.4 % was measured at brush's own interval, about 150 steps. Growth
-- selects the splats whose gradient has built up past a threshold, and at 20
-- steps a pass there is a fifth as much of it accumulated, so fewer clear the
-- bar. The shorter interval bought passes and lost yield, and the product of
-- the two went down.
--
-- Chasing it with a shorter interval again is a dead end: 26.7x at 5.1 % a
-- pass wants 66 passes, `refine_every` 11, and the signal each one reads gets
-- worse the further it is pushed. So the seed carries the tile and growth puts
-- the rest where the frames say the picture is wrong:
--
--     seed 22 500 -> 5.96x -> 134 000   (what happened)
--     seed 60 000 -> 5.96x -> 358 000   (a tenth: this)
--     seed 120 000 -> 5.96x -> capped
--
-- A tenth, not a fifth: the count was never the binding constraint. 134 000
-- splats over a z14 tile is 4.6 m apart, and the frames that teach them are
-- 1024 px over 1693 m — 1.65 m a pixel at best, and the cameras are oblique.
-- There is no gradient to sharpen a splat below a pixel, so a bigger budget
-- buys more splats and not more picture. What was actually wrong is the size
-- of them: SPREAD was a sigma being set as though it were a radius, and
-- `scale` widened the result again. Both are in this atom's params too. The seed is paid for on every step of the run,
-- and this is affordable now in a way it was not when db/0133 was written: a
-- step costs 351 ms on the card this was measured on, not the 765 it did.
--
-- Invariant 2: the seed share travels in the atom's params, and the trainer's
-- own default moves with it, so train-v11.
--
-- db/0139's build_dag with the seed a fifth of the budget.
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
        trn := new_atom(a_job, 'train', 'train-v11',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                -- Of the budget, seeded on the surface. A tenth: measured,
                -- not reasoned. See the header.
                'seed_share', 0.1,
                -- How much wider every trained splat is written than the
                -- trainer settled on. One: it was 1.3 on top of a seed sigma
                -- that was already four times too big, and widening is for a
                -- tile that is short of splats, not one whose splats are too
                -- large to begin with (client/atoms/train.js SPREAD).
                'scale', 1,
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
