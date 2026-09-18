-- 0134_atilesaysitsownlevels.sql — a tile says how much of itself is worth
-- drawing from here.
--
-- Until now a tile was all of its splats or none of them. `applyCaps` skipped
-- whole tiles that did not fit the viewer's budget, so the ground at the edge
-- of the view went missing rather than going coarse — about fifteen z14 tiles,
-- six and a half kilometres, and no middle between "crisp" and "further".
--
-- sog-v2 orders a tile's splats so that every prefix of them covers the whole
-- of it (client/lib/lodorder.js) and writes a second, tiny file beside the .sog
-- saying where the useful prefixes end. PlayCanvas's octree reads that file and
-- spends one budget across every tile on screen (PLAN-lod.md).
--
-- Two things here, and nothing else:
--
--   `lod`   the new kind of file, in db/0127's pattern. It is stored as
--           /tiles/{z}/{x}/{y}/{sha}.json, which can_write already allows
--           (db/0051_sharedbytes.sql) — the fixed name the engine matches on,
--           `lod-meta.json`, is what the viewer declares the asset is called
--           and never what is on disk. So Invariant 1 is untouched: the file
--           is content-addressed like every other, written once, cached for
--           ever, and a republished tile writes a different path.
--
--   sog-v2  in build_dag. The ordering changes the bytes, so every tile's .sog
--           sha moves and every merged ancestor dirties through the ordinary
--           path as its children republish. No blanket UPDATE here: when to
--           kick the recompile is a decision, not a migration.
ALTER TABLE artifact DROP CONSTRAINT artifact_kind_check;
ALTER TABLE artifact ADD CONSTRAINT artifact_kind_check CHECK (kind IN (
    'glb', 'thumb', 'dem', 'ortho', 'frames', 'init_ply',
    'ply', 'sog', 'height', 'colliders',
    'height_edit', 'cover', 'flow', 'material', 'lod'));

-- db/0133's build_dag, with the sog atom at v2.
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
        PERFORM new_atom(a_job, 'sog', 'sog-v2', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
    ELSE
        mrg := new_atom(a_job, 'merge', 'merge-v1',
            jsonb_build_object('children', child_sogs(a_z, a_x, a_y),
                               'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'voxel', 0.05, 'budget', budget), 0, '{}');
        PERFORM new_atom(a_job, 'sog', 'sog-v2', jsonb_build_object('ply', mrg),
            jsonb_build_object('budget', budget), 0, ARRAY[mrg]);
    END IF;
END
$$;
