-- 0009_atomid.sql — a merge atom must be identified by the tile it merges.
--
-- Invariant 2: an atom's identity is its inputs. build_dag hashed the merge
-- atom over {children, snapshot} and {voxel, budget} only, none of which
-- mentions (z, x, y). Two tiles at the same zoom that see the same features and
-- have no published children — every sibling of a fresh region, which is the
-- normal case — therefore produced the same atom_hash, and new_atom handed the
-- second job the first job's atom. The second job ended up with no atoms of its
-- own and could never publish. The assemble branch never had this problem: its
-- params already carry z, x and y.
--
-- The sog atom below it takes the merge atom's id as input, so distinguishing
-- the merge distinguishes the whole z <= 14 DAG.

CREATE OR REPLACE FUNCTION build_dag(a_job bigint, a_z int, a_x int, a_y int)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    snap      text := world_snapshot(a_z, a_x, a_y);
    base      jsonb;
    asm       bigint;
    frames    bigint [] := '{}';
    trn       bigint;
    sg        bigint;
    mrg       bigint;
    views     int := camera_views(a_z);
    chunk     int := frame_chunk();
    i         int;
    budget    bigint := tile_budget(a_z);
BEGIN
    IF a_z >= 16 THEN
        base := jsonb_build_object(
            'snapshot', snap,
            'geo_seed', coalesce(current_setting('app.geo_seed', true), 'v1'),
            'glb', instance_glbs(a_z, a_x, a_y));
        asm := new_atom(a_job, 'assemble', 'assemble-v1', base,
            jsonb_build_object('z', a_z, 'x', a_x, 'y', a_y,
                               'budget', budget), 0, '{}');
        i := 0;
        WHILE i < views LOOP
            frames := frames || new_atom(a_job, 'frame', 'frame-v1',
                jsonb_build_object('assemble', asm, 'snapshot', snap),
                jsonb_build_object('camera_set',
                        CASE WHEN a_z = 18 THEN 'z18-v1' ELSE 'z16-v1' END,
                    'from', i, 'to', least(i + chunk, views)), 0,
                ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v1',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', CASE WHEN a_z = 18 THEN 7000 ELSE 5000 END,
                'needs_webgpu', true,
                'min_vram_gb', CASE WHEN a_z = 18 THEN 4 ELSE 2 END), 0, frames);
        sg := new_atom(a_job, 'sog', 'sog-v1', jsonb_build_object('ply', trn),
            jsonb_build_object('budget', budget), 0, ARRAY[trn]);
        FOR i IN 1..3 LOOP
            PERFORM new_atom(a_job, 'verify', 'verify-v1',
                jsonb_build_object('sog', sg),
                jsonb_build_object('index', i, 'min_psnr', 22), 0, ARRAY[sg]);
        END LOOP;
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
