-- 0045_coarseleaf.sql — a tile with nothing under it is built, not merged.
--
-- `area.detail` says how fine the world is on that ground: 10, 12, 14, 16 or
-- 18 (db/0001_schema.sql). Tiles are made from z6 down to that number, so an
-- area drawn at detail 10 has no tiles below z10 at all.
--
-- Until now the DAG decided by zoom alone: z14 and finer were assembled, and
-- everything coarser was a merge of its sixteen children. For an area at detail
-- 10 that meant the finest tile it had was a merge of children that do not
-- exist — `merge-v1` throws "no published child", and db/0035_mergeready.sql
-- (rightly) never hands such an atom out. The ground was drawn in QGIS, the
-- tiles went dirty, and nothing ever rendered. Silently.
--
-- So the question is not "which zoom is this" but "is there anything finer
-- here": a tile with no children in `tile` is the bottom of its ladder, and it
-- is assembled and sampled exactly as a z14 leaf is.

-- Nothing finer exists on this ground, so this is where the world is made.
CREATE FUNCTION is_leaf_tile(a_z int, a_x int, a_y int) RETURNS boolean
LANGUAGE sql STABLE AS $$
SELECT a_z >= 14 OR NOT EXISTS (
    SELECT 1 FROM tile c
    WHERE c.z = a_z + 2
      AND c.x BETWEEN a_x * 4 AND a_x * 4 + 3
      AND c.y BETWEEN a_y * 4 AND a_y * 4 + 3);
$$;
GRANT EXECUTE ON FUNCTION is_leaf_tile(int, int, int) TO anon, player, admin;

-- db/0044_permission.sql's build_dag, with that one question asked instead of
-- the zoom comparison.
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
        asm := new_atom(a_job, 'assemble', 'assemble-v1', base,
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
                'needs_webgpu', true,
                'min_vram_gb', CASE WHEN a_z = 18 THEN 4 ELSE 2 END), 0, frames);
        PERFORM new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
    ELSIF leaf THEN
        smp := new_atom(a_job, 'sample', 'sample-v1',
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
