-- 0113_thetrainerlooksathalfthepicture.sql — a training step is a quarter of
-- the pixels it was.
--
-- 600 to 800 ms a step on a P2000, with the card at half load and the
-- processor at a tenth: neither is busy, which is what a card waiting on its
-- own memory looks like. A step is a forward and a backward pass over every
-- pixel of a view, and db/0104 put the trainer on the frames own 1024 px — a
-- megapixel a step against three hundred thousand splats, with the views
-- themselves (52 x 1024 x 1024 x 4 bytes, before the trainer has allocated a
-- single gradient) sitting in the same 5 GB as the splats, their gradients and
-- their optimiser state.
--
-- The frames stay 1024: they are what the tile is learned from and what verify
-- compares against. The trainer is told 512, and brush downsamples the views
-- it loads to that ("max-resolution", client/lib/brush.js). A quarter of the
-- pixels a step, a quarter of the picture memory, and the same frames on disk.
-- z16 trained at 512 until db/0104 and looked like itself.
--
-- db/0112'''s build_dag, with the one number split in two.
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
    tpx    int := 512;
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
                'iters', 1200,
                'size', tpx,
                'camera_set', cams,
                -- Of the budget, seeded on the surface: what is left is what
                -- brush grows where the frames say the picture is wrong.
                'seed_share', 0.75,
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
