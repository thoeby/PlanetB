-- 0096_anadoptedatommovesbylegalsteps.sql — an atom taken over from a closed
-- job gets there by the transitions the state machine allows, and a z16
-- frame is the size it is trained at.
--
-- db/0094 moved an unfinished atom out of a closed job into the job that
-- asked for it, in one UPDATE that set its state to `waiting`. The state
-- machine (db/0005_state.sql) allows claimed -> ready and ready -> waiting
-- and not claimed -> waiting, so an atom a dead tab had still been holding
-- raised "illegal atom transition claimed -> waiting" out of ensure_job —
-- which is to say out of the approval — and the tile could not be opened at
-- all. Two steps now, each of them legal.
--
-- And the frames: frame-v2 traced every view at 1024 px and 64 paths a pixel
-- whatever the tile, and a z16 tile is trained at 512 (db/0091), so three
-- quarters of every z16 frame was thrown away by the trainer. z16 frames are
-- 512 px; both zooms trace 32 paths a pixel.
CREATE OR REPLACE FUNCTION new_atom(a_job bigint, a_op text, a_algo text, a_inputs jsonb,
                                    a_params jsonb, a_seed int, a_deps bigint [])
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    h   text := atom_hash(a_op, a_algo, a_inputs, a_params, a_seed);
    aid bigint;
    have atom%rowtype;
BEGIN
    INSERT INTO atom (job_id, atom_hash, op, algo_version, deps, inputs,
                      params, seed, state)
    VALUES (a_job, h, a_op, a_algo, a_deps, a_inputs, a_params, a_seed,
            CASE WHEN cardinality(a_deps) = 0 THEN 'ready' ELSE 'waiting' END)
    ON CONFLICT (atom_hash) DO NOTHING
    RETURNING id INTO aid;
    IF aid IS NOT NULL THEN
        RETURN aid;
    END IF;

    -- Identical computation already exists; reuse it rather than repeat it.
    SELECT * INTO have FROM atom WHERE atom_hash = h FOR UPDATE;
    IF have.job_id <> a_job AND have.state <> 'verified'
       AND (have.state = 'failed' OR NOT EXISTS (
           SELECT 1 FROM job j WHERE j.id = have.job_id AND j.state = 'open')) THEN
        -- Every state but verified may go to ready; ready may go to waiting.
        UPDATE atom SET state = 'ready', job_id = a_job, deps = a_deps,
            attempts = 0, handed_back = 0, worker_id = NULL, claimed_at = NULL,
            heartbeat_at = NULL, output_sha256 = NULL, result = NULL
        WHERE id = have.id AND state <> 'ready';
        IF cardinality(a_deps) > 0 THEN
            UPDATE atom SET state = 'waiting', job_id = a_job, deps = a_deps
            WHERE id = have.id;
        ELSE
            UPDATE atom SET job_id = a_job, deps = a_deps WHERE id = have.id;
        END IF;
    END IF;
    RETURN have.id;
END
$$;

-- db/0095_thetrainerisbrush.sql's build_dag, framing z16 at 512 px and both
-- zooms at 32 paths a pixel.
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
    px     int := CASE WHEN a_z = 18 THEN 1024 ELSE 512 END;
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
            frames := frames || new_atom(a_job, 'frame', 'frame-v2',
                jsonb_build_object('assemble', asm, 'snapshot', snap),
                jsonb_build_object('camera_set', cams, 'samples', 32, 'bounces', 3,
                    'size', px,
                    'from', i, 'to', least(i + chunk, views)), 0, ARRAY[asm]);
            i := i + chunk;
        END LOOP;
        trn := new_atom(a_job, 'train', 'train-v3',
            jsonb_build_object('assemble', asm, 'frames', to_jsonb(frames)),
            jsonb_build_object('budget', budget,
                'iters', CASE WHEN a_z = 18 THEN 2000 ELSE 1500 END,
                'size', px,
                'camera_set', cams,
                'needs_webgpu', true,
                'min_buffer_mb', ceil(96::numeric * budget / 1048576)), 0, frames);
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
