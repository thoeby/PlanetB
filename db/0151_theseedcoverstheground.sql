-- 0151_theseedcoverstheground.sql — the seed covers the ground, and the cut's
-- voids are closed before they become geometry.
--
-- Two changes to what an atom computes, so two names.
--
-- `allocate` (client/lib/sampling.js) weighted the seed by area x detail, and
-- detailOf runs from 1 on smooth uniform ground to about 16 on an edge — so a
-- hillside got a sixteenth of its share. What covered it was the size of the
-- splats it did get: one per triangle, grown until it reached its neighbour,
-- which is the same overlap SPREAD 1.15 was buying. db/0145 cut SPREAD to 0.5
-- to stop the smear, and took the compensation with it: the thin places, which
-- had always been thin, became holes the frames showed sky through and the
-- trainer faithfully learned. Four fifths of the budget now goes by area
-- alone, which covers the ground whatever is on it, and the last fifth by
-- area x detail, which is the edges' extra. Coverage stops depending on how
-- big a splat is allowed to be. So train-v13.
--
-- And `assemble` fills the cut's voids before building the mesh (geo.js
-- fillVoids). A void is written as zero and the tile's datum is subtracted
-- from every sample, so an unfilled one is a pit two kilometres deep with
-- near-vertical walls rather than a gap. On a survey with no voids in it this
-- does nothing at all; it is a safeguard, not the fix. So assemble-v6, which
-- was already true of the code and is now true of the name.
--
-- Bumping assemble re-frames every tile, because the frames are of the mesh
-- it builds. That is the cost of both of these being wrong in the frames.
--
-- db/0148's build_dag at assemble-v6 and train-v13.
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
        asm := new_atom(a_job, 'assemble', 'assemble-v6', base,
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
        trn := new_atom(a_job, 'train', 'train-v13',
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
