-- 0131_theworldcanbebuiltsmall.sql — how big a tile is built is the operator's
-- choice, the way the renderer and the shadows are.
--
-- Since the sampler was removed every tile is trained, at every zoom. That is
-- what the operator's world wants and it is eight hours a tile on a software
-- adapter, which is what `make player-run` has to render on where there is no
-- GPU — so the stories that render could not be run at all on the machine the
-- work is done on. Three numbers, read where the job is built:
--
--     ALTER DATABASE splatworld SET splatworld.budget_scale = '0.05';
--     ALTER DATABASE splatworld SET splatworld.iters = '60';
--     ALTER DATABASE splatworld SET splatworld.frame_px = '192';
--
-- and every job opened after that carries the smaller numbers in its atoms'
-- params (Invariant 2: a tile built at a twentieth of the budget is a
-- different tile, and its atom_hash says so). Unset, the world is the size it
-- always was: nothing an operator does not ask for changes.
--
-- The scale is clamped to (0, 1]: this makes a world cheaper to build, never
-- more expensive than the zoom's own budget, and never empty.
CREATE OR REPLACE FUNCTION budget_scale() RETURNS numeric
LANGUAGE sql STABLE AS $$
SELECT least(greatest(
    coalesce(nullif(current_setting('splatworld.budget_scale', true), ''), '1')::numeric,
    0.001), 1);
$$;

CREATE OR REPLACE FUNCTION tile_budget(z int) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT (CASE z
    WHEN 18 THEN 2000000 WHEN 16 THEN 600000 WHEN 14 THEN 800000
    WHEN 12 THEN 900000 WHEN 10 THEN 1000000 WHEN 8 THEN 1200000
    ELSE 1500000 END)::bigint;
$$;

-- What a job is actually built with: the zoom's budget, scaled, and never so
-- small that there is nothing to look at.
CREATE OR REPLACE FUNCTION job_budget(z int) RETURNS bigint
LANGUAGE sql STABLE AS $$
SELECT greatest((tile_budget(z) * budget_scale())::bigint, 20000::bigint);
$$;

CREATE OR REPLACE FUNCTION train_iters() RETURNS int
LANGUAGE sql STABLE AS $$
SELECT greatest(
    coalesce(nullif(current_setting('splatworld.iters', true), ''), '1200')::int, 1);
$$;

CREATE OR REPLACE FUNCTION frame_px() RETURNS int
LANGUAGE sql STABLE AS $$
SELECT greatest(
    coalesce(nullif(current_setting('splatworld.frame_px', true), ''), '1024')::int, 64);
$$;

GRANT EXECUTE ON FUNCTION budget_scale(), job_budget(int), train_iters(), frame_px()
TO anon, player, admin;

-- db/0128's build_dag, with the three numbers asked for rather than written in.
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
        trn := new_atom(a_job, 'train', 'train-v7',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', train_iters(),
                'size', px,
                'camera_set', cams,
                -- Of the budget, seeded on the surface: what is left is what
                -- brush grows where the frames say the picture is wrong.
                'seed_share', 0.0375,
                -- How much wider every trained splat is written than the
                -- trainer settled on. Turn this up if the ground still shows
                -- through between them.
                'scale', 3,
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
