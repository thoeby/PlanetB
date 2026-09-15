-- 0107_therendererisachoice.sql — which renderer draws the frames.
--
-- client/lib/raster.js rasterises a frame in milliseconds with shadow maps and
-- the sky as an environment map; client/lib/pathtrace.js traces it in seconds
-- with the light bouncing between the surfaces. Against twenty-five minutes of
-- training, seconds a frame are nothing, so the choice is the operator's:
--
--     ALTER DATABASE splatworld SET splatworld.renderer = 'trace';
--     ALTER DATABASE splatworld SET splatworld.samples = '64';
--
-- and every job built after that carries it in its frame atoms' params, which
-- is what content-addresses them (Invariant 2): a tile built with the tracer
-- is a different tile from one built without. Unset, it is the rasteriser.
CREATE FUNCTION frame_renderer() RETURNS jsonb
LANGUAGE sql STABLE AS $$
SELECT CASE WHEN coalesce(current_setting('splatworld.renderer', true), '') = 'trace'
    THEN jsonb_build_object('renderer', 'trace',
        'samples', coalesce(nullif(current_setting('splatworld.samples', true), ''), '48')::int,
        'bounces', 3)
    ELSE '{}'::jsonb END;
$$;

-- db/0105's build_dag, the frames carrying the renderer.
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
        trn := new_atom(a_job, 'train', 'train-v3',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', 400,
                'size', px,
                'camera_set', cams,
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
