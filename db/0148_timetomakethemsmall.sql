-- 0148_timetomakethemsmall.sql — the run gets the second half it never had.
--
-- The tile is terrain now and not a smear, and what is left is splats the
-- trainer never shrank. Growth stops at 60 % of the run (client/lib/brush.js
-- configFor growth-stop-iter) and everything after it is the part that moves
-- colour, opacity and *size* with no new splats arriving — which is where a
-- splat gets small enough to be an edge rather than a blob. At 1 200
-- iterations that is 480 steps, and they are shared with a count that is
-- still doubling.
--
-- 2 400 iterations: 1 440 steps of growth and 960 of nothing but refinement.
-- At the 351 ms a step this was measured at, that is about fourteen minutes a
-- tile — what a tile cost before the readbacks were cut, so it buys the
-- second half back rather than costing anything new.
--
-- And `refine_every` goes to 30. A pass splits on the gradient accumulated
-- since the last one: twenty steps of it yielded 5.1 % a pass where brush's
-- own interval (about 150) yields 10.4 %. Thirty is a better-informed pass,
-- and the longer window holds forty-eight of them, which takes a tenth of the
-- budget past the cap without needing the noisier signal.
--
-- What this does not change, because it cannot: the frames are 1024 px over
-- 1693 m, 1.65 m a pixel and oblique, and no number of steps sharpens a splat
-- below what the picture teaching it can resolve. That is `frame_px`, it
-- costs forty-five path-traced views to raise, and it is the next thing.
--
-- Invariant 2: iters and refine_every travel in the atom's params, so
-- train-v12.
CREATE OR REPLACE FUNCTION train_iters() RETURNS int
LANGUAGE sql STABLE AS $$
SELECT greatest(
    coalesce(nullif(current_setting('splatworld.iters', true), ''), '2400')::int, 1);
$$;

-- db/0145's build_dag, refining for longer and splitting on a better signal.
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
        trn := new_atom(a_job, 'train', 'train-v12',
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
                -- How often brush looks for splats to split. Thirty rather
                -- than twenty: a pass reads the gradient built up since the
                -- last one, and twenty steps of it was a noisier signal that
                -- yielded 5.1 % where brush's own interval yields 10.4 %. The
                -- longer run has forty-eight passes at thirty anyway.
                'refine_every', 30,
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
