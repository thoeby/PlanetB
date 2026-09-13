-- 0080_onesky.sql — the world is lit by a sky, and the splats go where there
-- is something to see.
--
-- Two changes to what a tile is made of, both of them in the client
-- (Invariant 9 — the server computes none of it); this is the migration that
-- says so, because Invariant 2 pins an atom to its algo_version and a tile
-- compiled the old way keeps what it was made with.
--
-- `assemble-v2` (client/atoms/assemble.js, client/lib/sampling.js,
-- client/lib/light.js):
--
--  * The light was one number — 0.55 + 0.55 * max(dot(n, sun), 0) — which is a
--    lamp in a white room. Every face turned away from the sun was the same
--    flat grey and every face turned towards it the same flat bright, so a
--    mountainside arrived as one colour with no shape in it. It is a sun with a
--    colour, a blue sky from above and a little warmth bounced back up, and a
--    curve at the end because everything here is authored at a third of white
--    and a third of white is mud.
--  * The ground's own colour was three stops and two blends, which over a whole
--    valley is one green. It is a band for each thing a mountainside actually
--    is, and how much sky each point can see darkens the creases — the only
--    thing in a bare elevation model that shows its shape.
--  * Splats were spent evenly over area. A bare hillside is most of a tile and
--    was given as many as a roof edge; now the allocation is weighted by what
--    there is to see on each triangle, and each splat is the size of the
--    triangle it came from rather than of the tile's average.
--
-- `sample-v3` is the same sampler, published as the whole of a z14 tile.
--
-- The budget does not move. What changed is where the splats go.
CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap   text := world_snapshot(a_z, a_x, a_y);
    cams   text := CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v1' END;
    leaf   boolean := is_leaf_tile(a_z, a_x, a_y);
    base   jsonb;
    asm    bigint;
    frames bigint [] := '{}';
    trn    bigint;
    smp    bigint;
    mrg    bigint;
    views  int := camera_views(a_z);
    chunk  int := frame_chunk();
    i      int;
    budget bigint := tile_budget(a_z);
BEGIN
    IF leaf THEN
        base := jsonb_build_object('snapshot', snap,
            'glb', instance_glbs(a_z, a_x, a_y)) || geo_inputs(a_z, a_x, a_y);
        asm := new_atom(a_job, 'assemble', 'assemble-v2', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, '{}');
    END IF;

    IF a_z >= 16 THEN
        i := 0;
        WHILE i < views LOOP
            frames := frames || new_atom(a_job, 'frame', 'frame-v1',
                jsonb_build_object('assemble', asm, 'snapshot', snap),
                jsonb_build_object('camera_set', cams,
                    'from', i, 'to', least(i + chunk, views)), 0, ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v1',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', CASE WHEN a_z = 18 THEN 7000 ELSE 5000 END,
                'camera_set', cams,
                'needs_webgpu', true,
                'min_vram_gb', CASE WHEN a_z = 18 THEN 4 ELSE 2 END), 0, frames);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
    ELSIF leaf THEN
        smp := new_atom(a_job, 'sample', 'sample-v3',
            jsonb_build_object('assemble', asm, 'snapshot', snap),
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, ARRAY[asm]);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', smp),
            jsonb_build_object('budget', budget), 0, ARRAY[smp]);
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
