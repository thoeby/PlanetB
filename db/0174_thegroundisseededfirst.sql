-- 0174_thegroundisseededfirst.sql — the ground is seeded on its own, so a
-- trained tile has no sky under it.
--
-- The operator's report was "it still looks not great — can we make sure we
-- have a reasonable seed that covers the terrain so we definitely don't have
-- holes". Most of that was db/0173: the world was being built at a twentieth
-- of the budget for sixty iterations because a test run left its numbers on
-- the database. This is the rest of it, and it is real whatever the budget is.
--
-- The seed is allocated across every triangle in the tile at once
-- (client/lib/sampling.js). Two things then work against the ground:
--
-- a fifth of the budget is weighted by `detailOf`, which runs from 1 on smooth
-- uniform ground to about 16 on an edge. A hillside is one colour over
-- hundreds of square metres: it is the surface that loses every time, and it
-- is the one a player is always looking at. Measured on a hundred-metre square
-- of ground with four times its own area of roof and wall standing on it, the
-- ground was given a sixth of the seed: 1.8 m between its splats where the
-- roofs' were centimetres apart.
--
-- So the ground is sampled by itself, before anything that stands on it, and
-- given at least `ground_floor` of the seed however little there is to see on
-- it. Two thirds of a tenth of the budget is 53 000 splats over a z14 tile —
-- 7.3 m apart, and a splat two sigma wide at that spacing covers, with
-- overlap. On the tile above it takes the ground from a sixth of the seed to
-- two thirds, and its spacing from 1.8 m to 0.87 m.
--
-- What a tile is made of changes, so the name does (Invariant 2): train-v14,
-- with the share in the atom's params where the seed share already is.
-- `assemble` is untouched, so nothing is re-framed.
--
-- db/0163's build_dag at train-v14.
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
        asm := new_atom(a_job, 'assemble', 'assemble-v11', base,
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
        trn := new_atom(a_job, 'train', 'train-v14',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                -- Of the budget, seeded on the surface. A tenth: measured,
                -- not reasoned. See the header.
                'seed_share', 0.1,
                -- And how much of that seed is spent on the ground itself,
                -- whatever else is standing on the tile. Two thirds: see the
                -- header.
                'ground_floor', 0.66,
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
