-- 0070_therebuildopensitself.sql — what a publish opens, and what a submission
-- is for.
--
-- SPEC §5.3: "When a fine tile is published, its parent is marked `stale` and a
-- rebuild job (merge from published children, no training) opens in the same
-- pool at price 0 ... Coarse tiles contain only what was approved below, so
-- they need no approval of their own."
--
-- Three things follow from that sentence and none of them was true here.
--
-- 1. A submission carried every dirty tile from z6 down, so approving it opened
--    a merge job for every ancestor at once, each pinned to the version its
--    children had before anybody rendered them. The children then published,
--    dirty_parent moved the parent on, and those jobs could never publish
--    anything (Invariant 3): they sat in the pool as work nobody could finish.
--    A submission is the tiles that are built from what somebody drew — the
--    leaves of the ladder (db/0045_coarseleaf.sql).
-- 2. Nothing opened the rebuild. Job creation is ensure_job's alone
--    (Invariant 4), so publish_sog calls it, at price 0, after dirty_parent.
-- 3. render_pool listed merge jobs whose children are not published, which
--    claim_atom and claim_for have refused to hand out since
--    db/0035_mergeready.sql: the pool showed work and the button did nothing
--    (REFACTOR-direct-pg.md S7).

-- ------------------------------------------------- a submission is the leaves

CREATE OR REPLACE FUNCTION submit_area(p_area uuid, p_note text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    a       area%rowtype;
    sid     uuid;
    tiles   int := 0;
    approver uuid;
BEGIN
    SELECT * INTO a FROM area WHERE area.id = p_area;
    IF a.id IS NULL THEN
        RAISE EXCEPTION 'no such area %', p_area;
    END IF;
    IF NOT is_area_writer(p_area) THEN
        RAISE EXCEPTION 'that is not your land' USING errcode = '42501';
    END IF;

    INSERT INTO submission (area_id, by_id, note)
    VALUES (p_area, current_user_id(), coalesce(p_note, ''))
    RETURNING id INTO sid;

    INSERT INTO submission_tile (submission_id, z, x, y, at_version)
    SELECT sid, t.z, t.x, t.y, t.expected_version
    FROM tile t
    WHERE t.dirty AND t.expected_version > 0
      AND is_leaf_tile(t.z, t.x, t.y)
      AND st_intersects(a.geom, tile_bbox(t.z, t.x, t.y))
      AND NOT EXISTS (
          SELECT 1 FROM submission s
          JOIN submission_tile st ON st.submission_id = s.id
          WHERE s.state = 'open' AND st.z = t.z AND st.x = t.x AND st.y = t.y);
    GET DIAGNOSTICS tiles = ROW_COUNT;

    IF tiles = 0 THEN
        DELETE FROM submission WHERE id = sid;
        RAISE EXCEPTION 'nothing to submit — nothing on this land has changed'
                        ' since it was last sent'
            USING errcode = '23514';
    END IF;

    -- The person who decides. When that is the submitter, nobody is told:
    -- they are looking at it (SPEC §2.7).
    approver := a.owner_id;
    IF approver <> current_user_id() THEN
        PERFORM tell(approver, 'submission_waiting',
                     player_name(current_user_id()) || ' submitted '
                     || tiles || ' tile' || CASE WHEN tiles = 1 THEN '' ELSE 's' END
                     || ' of ' || coalesce(a.rules ->> 'name', 'your land')
                     || ' for your approval',
                     jsonb_build_object('panel', 'Permission', 'submission', sid,
                                        'lon', st_x(st_pointonsurface(a.geom)),
                                        'lat', st_y(st_pointonsurface(a.geom))));
    END IF;

    RETURN jsonb_build_object('id', sid, 'tiles', tiles,
                              'yours_to_approve', approver = current_user_id(),
                              'changes', submission_changes(p_area));
END
$$;

-- And the two counts that have to agree with it, or the panel offers to submit
-- what pressing Submit would not send.
CREATE OR REPLACE FUNCTION submission_changes(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object(
    'tiles', (SELECT count(*) FROM tile t
              WHERE t.dirty AND t.expected_version > 0
                AND is_leaf_tile(t.z, t.x, t.y)
                AND st_intersects((SELECT geom FROM area WHERE id = p_area),
                                  tile_bbox(t.z, t.x, t.y))),
    'objects', (SELECT count(*) FROM instance i
                WHERE i.area_id = p_area AND i.deleted_at IS null),
    'moved', (SELECT count(*) FROM instance i
              WHERE i.area_id = p_area AND i.deleted_at IS null AND i.rev > 1),
    'features', (SELECT count(*) FROM feature f
                 WHERE f.area_id = p_area AND f.deleted_at IS null));
$$;

CREATE OR REPLACE FUNCTION area_progress(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object(
    'tiles', count(*),
    'published', count(*) FILTER (WHERE t.published_version >= t.expected_version),
    'waiting', count(*) FILTER (WHERE t.dirty),
    'awaiting', count(*) FILTER (WHERE tile_state(t) = 'awaiting approval'),
    'to_submit', count(*) FILTER (
        WHERE t.dirty AND t.expected_version > 0
          AND is_leaf_tile(t.z, t.x, t.y) AND NOT EXISTS (
            SELECT 1 FROM submission s
            JOIN submission_tile st ON st.submission_id = s.id
            WHERE s.state = 'open' AND st.z = t.z AND st.x = t.x AND st.y = t.y)),
    'queued', count(*) FILTER (WHERE tile_state(t) IN ('queued', 'rendering')),
    'open_jobs', (SELECT count(*) FROM job j
                  WHERE j.state = 'open' AND EXISTS (
                      SELECT 1 FROM area a WHERE a.id = p_area
                        AND st_intersects(a.geom, tile_bbox(j.z, j.x, j.y)))),
    'in_escrow', coalesce((SELECT sum(j.bounty) FROM job j
                  WHERE j.state = 'open' AND EXISTS (
                      SELECT 1 FROM area a WHERE a.id = p_area
                        AND st_intersects(a.geom, tile_bbox(j.z, j.x, j.y)))), 0))
FROM tile t
WHERE EXISTS (SELECT 1 FROM area a WHERE a.id = p_area
              AND st_intersects(a.geom, tile_bbox(t.z, t.x, t.y)));
$$;

-- ------------------------------------------------ the rebuild opens by itself

-- db/0026_review.sql's ensure_job, with one question added to the authorisation
-- it does. Opening a job for free stays the owner's or an admin's, because it
-- is asking strangers to spend their electricity on your ground — and because
-- a free job opened first is the job a later bounty cannot attach to. The one
-- exception is the rebuild of a coarse tile, which nobody asks for: publishing
-- a child is what opens it (SPEC §5.3), and publish_sog says so by setting
-- splatworld.rebuild for the length of its own transaction. Nothing a client
-- can send sets that: PostgREST does not hand out arbitrary settings, and the
-- only function that writes it is the one below it.
CREATE OR REPLACE FUNCTION ensure_job(z int, x int, y int,
                                      bounty numeric DEFAULT 0)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    t   tile%rowtype;
    jid bigint;
    old bigint;
BEGIN
    SELECT * INTO t FROM tile
    WHERE tile.z = ensure_job.z AND tile.x = ensure_job.x AND tile.y = ensure_job.y;
    IF t.z IS NULL THEN
        RAISE EXCEPTION 'no such tile %/%/%', z, x, y;
    END IF;
    IF t.expected_version = 0 THEN
        RAISE EXCEPTION 'tile %/%/% has no world input yet', z, x, y;
    END IF;

    IF bounty <= 0
       AND current_user_role() <> 'admin'
       AND coalesce(current_setting('splatworld.rebuild', true), '') <> '1'
       AND NOT EXISTS (
           SELECT 1 FROM area
           WHERE st_intersects(area.geom, tile_bbox(z, x, y))
             AND is_area_writer(area.id)) THEN
        RAISE EXCEPTION 'not authorised for %/%/% and no bounty attached', z, x, y;
    END IF;

    SELECT id INTO jid FROM job
    WHERE job.z = ensure_job.z AND job.x = ensure_job.x AND job.y = ensure_job.y
      AND job.target_version = t.expected_version;
    IF jid IS NOT NULL THEN
        RETURN jid;
    END IF;

    FOR old IN SELECT id FROM job
               WHERE job.z = ensure_job.z AND job.x = ensure_job.x
                 AND job.y = ensure_job.y AND job.state = 'open'
                 AND job.target_version < t.expected_version LOOP
        UPDATE job SET state = 'cancelled' WHERE id = old;
        PERFORM refund_bounty(old);
    END LOOP;

    INSERT INTO job (z, x, y, target_version)
    VALUES (z, x, y, t.expected_version) RETURNING id INTO jid;
    PERFORM build_dag(jid, z, x, y);
    IF bounty > 0 THEN
        PERFORM set_bounty(jid, bounty);
    END IF;
    RETURN jid;
END
$$;

-- db/0069_approvalverbs.sql's publish_sog, with the rebuild opened where the
-- parent is made stale. Free: nobody chose to rebuild it, the world did.
CREATE OR REPLACE FUNCTION publish_sog(a atom, p_by uuid, p_manifest jsonb)
RETURNS boolean
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    j job%rowtype;
BEGIN
    SELECT * INTO j FROM job WHERE id = a.job_id;
    IF j.id IS NULL OR a.output_sha256 IS NULL OR p_manifest IS NULL THEN
        RETURN false;
    END IF;

    -- Coarse before fine (db/0010_lockorder.sql).
    IF j.z > 6 THEN
        PERFORM 1 FROM tile parent
        WHERE parent.z = j.z - 2 AND parent.x = j.x / 4 AND parent.y = j.y / 4
        FOR UPDATE;
    END IF;

    -- Invariant 3: the compare-and-swap is on expected_version, so a worker
    -- holding a stale render can never publish.
    UPDATE tile t
    SET published_version = j.target_version,
        sog_sha256 = a.output_sha256,
        manifest = p_manifest,
        published_at = now(),
        published_by = p_by,
        refused_note = NULL,
        dirty = t.expected_version > j.target_version
    WHERE t.z = j.z AND t.x = j.x AND t.y = j.y
      AND t.expected_version = j.target_version
      AND t.published_version < j.target_version;
    IF NOT found THEN
        RETURN false;
    END IF;

    UPDATE job SET state = 'done' WHERE id = j.id;
    PERFORM release_escrow(j.id);
    -- The ladder above follows: a finer tile published makes its parent stale
    -- and puts its rebuild in the pool (SPEC §0.2, §5.3).
    IF j.z > 6 THEN
        PERFORM dirty_parent(j.z, j.x, j.y);
        -- Nobody asked for this one, so it is not asked of anybody's
        -- authorisation either; it is what publishing a child means.
        PERFORM set_config('splatworld.rebuild', '1', true);
        PERFORM ensure_job(j.z - 2, j.x / 4, j.y / 4, 0);
        PERFORM set_config('splatworld.rebuild', '', true);
    END IF;
    RETURN true;
END
$$;

-- ------------------------------------------------ the ground an atom is given

-- db/0039_ground.sql pinned the elevation an assemble reads as its hash and the
-- tile it was cut for — and wrote that tile as three numbers. An atom's inputs
-- say a number means another atom of this job (client/js/inputs.js), so the
-- first tab ever to run an assemble through the work loop asked the world for
-- "atom 8550", which is the x of the tile. The tile is one string now, and the
-- hash beside it is still what is pinned (Invariant 2).
CREATE OR REPLACE FUNCTION geo_inputs(p_z int, p_x int, p_y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
SELECT coalesce(
    (SELECT jsonb_build_object('dem', g.sha256,
                               'dem_at', g.z || '/' || g.x || '/' || g.y)
     FROM geo_tile g
     WHERE g.z <= p_z
       AND g.x = p_x / (1 << (p_z - g.z))
       AND g.y = p_y / (1 << (p_z - g.z))
     ORDER BY g.z DESC
     LIMIT 1),
    '{}'::jsonb);
$$;

-- ------------------------------------------- and only work that can be landed

-- db/0050_fix_claim_for_merge_readiness.sql's claim_for, with the rule
-- db/0052_staleclaim.sql put in claim_atom and not in this one: a job whose
-- tile has moved past the version it compiles can finish every atom and
-- publish none of them (Invariant 3). The player-run found it the expensive
-- way — a tab took a job, assembled for a minute, and was told "the world
-- moved" by its own atom.
CREATE OR REPLACE FUNCTION claim_for(p_job bigint, p_caps jsonb DEFAULT '{}'::jsonb)
RETURNS atom
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    wid uuid;
    a   atom%rowtype;
BEGIN
    PERFORM expire_claims();
    wid := my_worker(p_caps);

    SELECT a2.* INTO a
    FROM atom a2
    JOIN job j ON j.id = a2.job_id AND j.state = 'open'
    JOIN tile t ON t.z = j.z AND t.x = j.x AND t.y = j.y
    WHERE a2.job_id = p_job
      AND a2.state = 'ready'
      AND j.target_version = t.expected_version
      AND (a2.op <> 'merge' OR merge_has_a_child(a2.inputs))
      AND (NOT coalesce((a2.params ->> 'needs_webgpu')::boolean, false)
           OR coalesce((p_caps ->> 'webgpu')::boolean, false))
      AND coalesce((a2.params ->> 'min_vram_gb')::numeric, 0)
          <= coalesce((p_caps ->> 'vram_gb')::numeric, 0)
    ORDER BY a2.id
    FOR UPDATE OF a2 SKIP LOCKED
    LIMIT 1;

    IF a.id IS NULL THEN
        RETURN NULL;
    END IF;
    UPDATE atom SET state = 'claimed', worker_id = wid,
                    claimed_at = now(), heartbeat_at = now()
    WHERE atom.id = a.id RETURNING * INTO a;
    RETURN a;
END
$$;

-- ------------------------------------------------- the pool offers only work

-- db/0060_crssaysitonce.sql's render_pool, saying what each job is and what it
-- needs, and not listing a merge nobody can take yet (S7). What the job is
-- comes from its own atoms rather than from the zoom: a tile with nothing
-- under it is assembled whatever its zoom (db/0045_coarseleaf.sql).
CREATE OR REPLACE FUNCTION render_pool(p_lon double precision DEFAULT null,
                                       p_lat double precision DEFAULT null,
                                       p_limit int DEFAULT 40) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(j ORDER BY j ->> 'ordering'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object(
        'job', job.id, 'z', job.z, 'x', job.x, 'y', job.y,
        'bounty', job.bounty, 'version', job.target_version,
        'opened_at', job.created_at,
        'ready', (SELECT count(*) FROM atom a
                  WHERE a.job_id = job.id AND a.state IN ('ready', 'waiting')),
        'claimed', (SELECT count(*) FROM atom a
                    WHERE a.job_id = job.id AND a.state = 'claimed'),
        'failed', (SELECT count(*) FROM atom a
                   WHERE a.job_id = job.id AND a.state = 'failed'),
        'may_retry', may_retry_job(job.id),
        'made', CASE
            WHEN EXISTS (SELECT 1 FROM atom a
                         WHERE a.job_id = job.id AND a.op = 'train') THEN 'trained'
            WHEN EXISTS (SELECT 1 FROM atom a
                         WHERE a.job_id = job.id AND a.op = 'assemble') THEN 'assembled'
            ELSE 'merged from its children' END,
        'needs_webgpu', EXISTS (
            SELECT 1 FROM atom a WHERE a.job_id = job.id
              AND coalesce((a.params ->> 'needs_webgpu')::boolean, false)),
        'metres', CASE WHEN p_lon IS NULL THEN NULL ELSE
            st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                        st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography) END,
        'ordering', lpad((1000000 - least(job.bounty, 999999))::bigint::text, 9, '0')
            || lpad(coalesce(CASE WHEN p_lon IS NULL THEN 0 ELSE
                st_distance(st_centroid(tile_bbox(job.z, job.x, job.y))::geography,
                            st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography)
                END, 0)::bigint::text, 12, '0')
            || lpad((18 - job.z)::text, 2, '0')) AS j
    FROM job
    JOIN tile t ON t.z = job.z AND t.x = job.x AND t.y = job.y
    WHERE job.state = 'open'
      -- Not a version the world has moved past: that job can finish every atom
      -- it has and publish none of them (Invariant 3, db/0052_staleclaim.sql).
      AND job.target_version = t.expected_version
      -- A job whose every atom has failed still belongs here: it is what
      -- somebody has to look at, and there is a button for it.
      AND EXISTS (SELECT 1 FROM atom a WHERE a.job_id = job.id
                  AND a.state IN ('ready', 'waiting', 'claimed', 'failed'))
      -- S7: not a merge of children nobody has published. claim_atom and
      -- claim_for will not hand it out (db/0035_mergeready.sql), so listing it
      -- is offering work that cannot be taken.
      AND NOT EXISTS (SELECT 1 FROM atom a
                      WHERE a.job_id = job.id AND a.op = 'merge'
                        AND a.state IN ('ready', 'waiting')
                        AND NOT merge_has_a_child(a.inputs))
    ORDER BY job.bounty DESC, job.id
    LIMIT greatest(p_limit, 0)
) pool;
$$;
