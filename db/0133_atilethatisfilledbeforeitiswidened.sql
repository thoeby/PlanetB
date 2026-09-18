-- 0133_atilethatisfilledbeforeitiswidened.sql — the seed is half the budget,
-- the splats are not blown up to hide the gaps, and brush is given more than
-- five chances to grow.
--
-- A z14 tile came back with 37 000 splats of a 600 000 budget. Nothing failed:
-- brush grows by a fraction of what it holds at each refine, `configFor` stops
-- growth at 60 % of the run, and its own refine interval leaves about five of
-- them in 1 200 steps. 22 500 seeded, five passes at about eleven per cent,
-- 37 000 out — one splat per 77 m² of a 1.7 km tile, which `scale` 3 then blew
-- into twenty-six-metre blobs to cover the ground between them. That is the
-- smear a player was looking at.
--
-- Reaching the budget from a fortieth of it needs about thirty-two passes, or
-- eight thousand steps. From a half it needs seven, which 1 200 steps has:
--
--     seed_share 0.0375 =  22 500 -> 32 passes (4 800 iterations of growth)
--     seed_share 0.5    = 300 000 ->  7 passes (1 014)
--
-- So the seed goes back to half the budget, `refine_every` is asked for rather
-- than left to brush (fifty gives fourteen passes in the window instead of
-- five), and `scale` comes down to 1.3 — widening is for the overlap a filled
-- tile needs, not for hiding one that is empty.
--
-- Invariant 2: all three travel in the atom's params, so a tile built this way
-- is a different tile from the one before it and its atom_hash says so. The
-- trainer reads them (client/atoms/train.js, train-v8).
--
-- db/0131's build_dag with those three numbers.
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
        trn := new_atom(a_job, 'train', 'train-v8',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                -- Of the budget, seeded on the surface: what is left is what
                -- brush grows where the frames say the picture is wrong, and
                -- how much of it it can grow in this many steps is the whole
                -- of why this is a half and not a fortieth.
                'seed_share', 0.5,
                -- How much wider every trained splat is written than the
                -- trainer settled on. Turn this up if the ground still shows
                -- through between them — but a tile that is short of splats
                -- is not one this can cover.
                'scale', 1.3,
                -- How often brush looks for splats to split. Its own default
                -- gives a 1 200-step run about five chances to grow.
                'refine_every', 50,
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
