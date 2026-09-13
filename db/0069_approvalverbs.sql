-- 0069_approvalverbs.sql — submit, approve, refuse, and publish on landing.
--
-- db/0068_approvalfirst.sql holds what a submission is and what a tile's state
-- is; this is what people do about it. Two files because one would be over
-- four hundred lines, which is the limit CLAUDE.md sets for a reason: nobody
-- reads the second half.

-- ------------------------------------------------------------- submitting

-- Submitting is asking, not queueing: it makes one submission over every tile
-- of this land that has changed and is not already waiting for an answer.
--
-- The old one took a price and opened the jobs itself; it is dropped rather
-- than left beside this, or `submit_area(uuid, 'a note')` is ambiguous and the
-- caller gets "could not choose a best candidate function" instead of a world.
DROP FUNCTION IF EXISTS api.submit_area(uuid, numeric);
DROP FUNCTION IF EXISTS submit_area(uuid, numeric);

CREATE FUNCTION submit_area(p_area uuid, p_note text DEFAULT '')
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

GRANT EXECUTE ON FUNCTION submit_area(uuid, text) TO player, admin;

-- The middle of what somebody changed on this land: the things they placed
-- and the shapes they drew, taken together. Falls back to the land itself when
-- there is nothing on it.
-- The objects first: a bench somebody put down is a thing to stand in front
-- of, and a wood drawn around it would pull the middle into the trees.
CREATE FUNCTION where_changed(p_area uuid, p_land geometry) RETURNS geometry
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(
    (SELECT st_centroid(st_collect(i.geom)) FROM instance i
     WHERE i.area_id = p_area AND i.deleted_at IS null),
    (SELECT st_pointonsurface(st_collect(st_force2d(f.geom))) FROM feature f
     WHERE f.area_id = p_area AND f.deleted_at IS null),
    st_pointonsurface(p_land));
$$;

GRANT EXECUTE ON FUNCTION where_changed(uuid, geometry) TO anon, player, admin;

-- What is waiting for me to say yes or no to (SPEC §2.9 "Waiting for me").
CREATE FUNCTION submissions_waiting() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, auth AS $$
SELECT coalesce(jsonb_agg(row ORDER BY row ->> 'at'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object(
        'id', s.id, 'area_id', s.area_id,
        'land', coalesce(a.rules ->> 'name', 'unnamed land'),
        'by', player_name(s.by_id), 'mine', s.by_id = current_user_id(),
        'note', s.note, 'at', s.created_at,
        'tiles', (SELECT count(*) FROM submission_tile st
                  WHERE st.submission_id = s.id),
        'superseded', EXISTS (
            SELECT 1 FROM submission_tile st JOIN tile t
              ON t.z = st.z AND t.x = st.x AND t.y = st.y
            WHERE st.submission_id = s.id AND t.expected_version > st.at_version),
        'changes', submission_changes(s.area_id),
        -- Where to look: the middle of what was built, not the middle of the
        -- land. A z14 tile is nearly two kilometres across, and being flown to
        -- its centre is being flown somewhere else (SPEC §2.9 "Review").
        'lon', st_x(where_changed(s.area_id, a.geom)),
        'lat', st_y(where_changed(s.area_id, a.geom))) AS row
    FROM submission s
    JOIN area a ON a.id = s.area_id
    WHERE s.state = 'open'
      AND (is_area_owner(a.id) OR has_area_right(a.id, 'approve')
           OR current_user_role() = 'admin')
) q;
$$;

GRANT EXECUTE ON FUNCTION submissions_waiting() TO player, admin;

-- Yes. The tiles are queued: a render job opens for each, and nobody is asked
-- anything again — the compile publishes when it lands (SPEC §0.2).
CREATE FUNCTION approve_submission(p_id uuid, p_price numeric DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    s      submission%rowtype;
    a      area%rowtype;
    t      record;
    opened int := 0;
BEGIN
    SELECT * INTO s FROM submission WHERE id = p_id FOR UPDATE;
    IF s.id IS NULL THEN
        RAISE EXCEPTION 'no such submission' USING errcode = '23503';
    END IF;
    SELECT * INTO a FROM area WHERE id = s.area_id;
    IF NOT (is_area_owner(a.id) OR has_area_right(a.id, 'approve')
            OR current_user_role() = 'admin') THEN
        RAISE EXCEPTION 'that is not your ground to approve' USING errcode = '42501';
    END IF;
    IF s.state <> 'open' THEN
        RAISE EXCEPTION 'that submission was already %', s.state
            USING errcode = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM submission_tile st JOIN tile t2
                 ON t2.z = st.z AND t2.x = st.x AND t2.y = st.y
               WHERE st.submission_id = p_id AND t2.expected_version > st.at_version)
    THEN
        RAISE EXCEPTION 'this changed since it was submitted — ask for it again'
            USING errcode = '23514';
    END IF;

    -- Coarse before fine, as every other writer of `tile` does
    -- (db/0010_lockorder.sql).
    FOR t IN SELECT st.z, st.x, st.y FROM submission_tile st
             WHERE st.submission_id = p_id ORDER BY st.z, st.x, st.y
    LOOP
        PERFORM ensure_job(t.z, t.x, t.y, coalesce(p_price, 0));
        opened := opened + 1;
    END LOOP;

    UPDATE submission SET state = 'approved', decided_at = now(),
                          decided_by = current_user_id()
    WHERE id = p_id;

    IF s.by_id <> current_user_id() THEN
        PERFORM tell(s.by_id, 'submission_approved',
                     player_name(current_user_id()) || ' approved your '
                     || opened || ' tile' || CASE WHEN opened = 1 THEN '' ELSE 's' END
                     || ' — they are in the render pool now',
                     jsonb_build_object('panel', 'Render pool',
                                        'lon', st_x(st_pointonsurface(a.geom)),
                                        'lat', st_y(st_pointonsurface(a.geom))));
    END IF;
    RETURN jsonb_build_object('id', p_id, 'queued', opened);
END
$$;

GRANT EXECUTE ON FUNCTION approve_submission(uuid, numeric) TO player, admin;

-- No, and why not. The tiles stay changed; the note is what the submitter
-- reads on the land card and on every object that was in it (SPEC §3.6).
CREATE FUNCTION refuse_submission(p_id uuid, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    s submission%rowtype;
    a area%rowtype;
BEGIN
    SELECT * INTO s FROM submission WHERE id = p_id FOR UPDATE;
    IF s.id IS NULL THEN
        RAISE EXCEPTION 'no such submission' USING errcode = '23503';
    END IF;
    SELECT * INTO a FROM area WHERE id = s.area_id;
    IF NOT (is_area_owner(a.id) OR has_area_right(a.id, 'approve')
            OR current_user_role() = 'admin') THEN
        RAISE EXCEPTION 'that is not your ground to refuse' USING errcode = '42501';
    END IF;
    IF s.state <> 'open' THEN
        RAISE EXCEPTION 'that submission was already %', s.state
            USING errcode = '23514';
    END IF;
    IF length(btrim(coalesce(p_note, ''))) < 10 THEN
        RAISE EXCEPTION 'say why, in a sentence — a refusal without a reason is'
                        ' not something anybody can act on'
            USING errcode = '23514';
    END IF;

    UPDATE submission SET state = 'refused', refused_note = btrim(p_note),
                          decided_at = now(), decided_by = current_user_id()
    WHERE id = p_id;

    IF s.by_id <> current_user_id() THEN
        PERFORM tell(s.by_id, 'submission_refused',
                     player_name(current_user_id()) || ' refused: ' || btrim(p_note),
                     jsonb_build_object('panel', 'Your land',
                                        'lon', st_x(st_pointonsurface(a.geom)),
                                        'lat', st_y(st_pointonsurface(a.geom))));
    END IF;
    RETURN jsonb_build_object('id', p_id, 'note', btrim(p_note));
END
$$;

GRANT EXECUTE ON FUNCTION refuse_submission(uuid, text) TO player, admin;

-- The last word said about this land, for the card and for the objects on it.
CREATE FUNCTION area_refusal(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, auth AS $$
SELECT coalesce((
    SELECT jsonb_build_object('note', s.refused_note, 'at', s.decided_at,
                              'by', player_name(s.decided_by))
    FROM submission s
    WHERE s.area_id = p_area AND s.state = 'refused'
    ORDER BY s.decided_at DESC LIMIT 1), '{}'::jsonb);
$$;

GRANT EXECUTE ON FUNCTION area_refusal(uuid) TO anon, player, admin;

-- ---------------------------------------------------- publishing on landing

-- What lands is published (SPEC §0.2: "publishes on landing without a second
-- decision"). db/0044_permission.sql made it a candidate instead, because the
-- decision came after the render; it comes before now, and this is
-- db/0017_verify.sql's publish_sog again.
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
    -- (SPEC §0.2, §5.3).
    IF j.z > 6 THEN
        PERFORM dirty_parent(j.z, j.x, j.y);
    END IF;
    RETURN true;
END
$$;

CREATE FUNCTION api.submission_changes(area_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.submission_changes(area_id)$$;

CREATE FUNCTION api.submissions_waiting() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.submissions_waiting()$$;

CREATE FUNCTION api.approve_submission(submission_id uuid, price numeric DEFAULT 0)
RETURNS jsonb LANGUAGE sql VOLATILE
AS $$SELECT public.approve_submission(submission_id, price)$$;

CREATE FUNCTION api.refuse_submission(submission_id uuid, note text) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.refuse_submission(submission_id, note)$$;

CREATE FUNCTION api.area_refusal(area_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.area_refusal(area_id)$$;

CREATE FUNCTION api.submit_area(area_id uuid, note text DEFAULT '')
RETURNS jsonb LANGUAGE sql VOLATILE
AS $$SELECT public.submit_area(area_id, note)$$;

REVOKE ALL ON FUNCTION tile_state(tile), submission_changes(uuid),
    where_changed(uuid, geometry),
    submissions_waiting(), approve_submission(uuid, numeric),
    refuse_submission(uuid, text), area_refusal(uuid), submit_area(uuid, text),
    api.submissions_waiting(), api.approve_submission(uuid, numeric),
    api.refuse_submission(uuid, text), api.area_refusal(uuid),
    api.submit_area(uuid, text), api.submission_changes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tile_state(tile), submission_changes(uuid),
    where_changed(uuid, geometry), area_refusal(uuid), api.area_refusal(uuid),
    api.submission_changes(uuid) TO anon, player, admin;
GRANT EXECUTE ON FUNCTION submissions_waiting(), approve_submission(uuid, numeric),
    refuse_submission(uuid, text), submit_area(uuid, text),
    api.submissions_waiting(), api.approve_submission(uuid, numeric),
    api.refuse_submission(uuid, text), api.submit_area(uuid, text)
    TO player, admin;

-- What the land is waiting for, now that waiting has two shapes: tiles nobody
-- has been asked about yet, and tiles somebody has been asked about and has
-- not answered. A panel that cannot tell them apart offers to submit what is
-- already submitted.
CREATE OR REPLACE FUNCTION area_progress(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object(
    'tiles', count(*),
    'published', count(*) FILTER (WHERE t.published_version >= t.expected_version),
    'waiting', count(*) FILTER (WHERE t.dirty),
    'awaiting', count(*) FILTER (WHERE tile_state(t) = 'awaiting approval'),
    -- What pressing Submit would send: exactly what submit_area() picks up.
    -- Not "dirty minus jobs": a tile queued for an older version and changed
    -- since is a tile to submit again.
    'to_submit', count(*) FILTER (
        WHERE t.dirty AND t.expected_version > 0 AND NOT EXISTS (
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
