-- 0105_droppedmeansgone.sql — a dropped job leaves nothing behind, and the
-- training steps come down to 400.
--
-- drop_job (db/0102) cancelled the job and stopped there. The tile still had
-- expected_version above what was published, so it stayed "changed" in every
-- count, in every open submission, and the next ensure_job made the same job
-- again. Dropped means gone: the job is cancelled, its bounty refunded, the
-- tile's expected_version is set back to what is published (0 if nothing is:
-- the tile is bare ground until somebody asks for it again), and it leaves
-- every open submission. Any open job of yours can be dropped, not only one
-- that failed.
--
-- 400 training steps: with the frames being the mesh, brush places its
-- splats in the first few hundred and the rest was minutes for nothing.
CREATE OR REPLACE FUNCTION drop_job(p_job bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    j job%rowtype;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    IF NOT may_retry_job(p_job) THEN
        RAISE EXCEPTION 'that ground is not yours to drop' USING errcode = '42501';
    END IF;
    SELECT * INTO j FROM job WHERE id = p_job FOR UPDATE;
    IF j.id IS NULL OR j.state <> 'open' THEN
        RETURN false;
    END IF;
    UPDATE job SET state = 'cancelled' WHERE id = p_job;
    PERFORM refund_bounty(p_job);
    -- Its pieces are not left for a tab to pick up out of a closed job.
    UPDATE atom SET state = 'failed', worker_id = NULL, claimed_at = NULL,
                    heartbeat_at = NULL
    WHERE job_id = p_job AND state IN ('waiting', 'ready', 'claimed');
    UPDATE tile SET expected_version = published_version, dirty = false
    WHERE z = j.z AND x = j.x AND y = j.y;
    DELETE FROM submission_tile st USING submission s
    WHERE s.id = st.submission_id AND s.state = 'open'
      AND st.z = j.z AND st.x = j.x AND st.y = j.y;
    RETURN true;
END
$$;

-- db/0104's build_dag with 400 steps.
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
                    'from', i, 'to', least(i + chunk, views)), 0, ARRAY[asm]);
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
