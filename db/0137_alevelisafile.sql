-- 0137_alevelisafile.sql — a tile seen from far away fetches a far-away tile.
--
-- sog-v2 put the levels in one file as prefixes of it: the engine drew a
-- fortieth of a distant tile and downloaded all of it to do so. The levels
-- bounded what was drawn and nothing at all about what crossed the wire, which
-- is the half that decides whether somebody can fly over a world or walk into
-- one that has been surveyed at z20 (PLAN-lod.md risk 2, risk 3).
--
-- sog-v3 writes one file per level. A level names its own file
-- (framework/parsers/gsplat-octree.js), the octree reference-counts the files
-- it is currently drawing from, and a tile at its coarsest level costs its
-- coarsest file. About a third more storage — a coarse level's splats are in
-- the fine level's file too — for a fortieth of the traffic where it counts.
--
-- And each coarse level is widened to the voxel its splats speak for
-- (client/lib/lodorder.js cover). A quarter as many splats at the same size is
-- a sieve rather than a coarser tile, and `merge` has always done the same
-- thing for the same reason (client/atoms/merge.js, a cluster floored at half
-- its voxel). That was the open risk in PLAN-lod.md and this closes it by
-- construction rather than by hoping.
--
-- db/0134's build_dag with the sog atom at v3.
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
