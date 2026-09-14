-- 0086_thepoolisapanelwiththatname.sql — a notification that opens something.
--
-- db/0069_approvalverbs.sql tells the person whose tiles were approved that
-- they are in the render pool now, and hands the page 'Render pool' to open.
-- No panel has ever been called that: the surface was Work, and since the
-- queues were split out of it the body is 'Render jobs' (client/js/tabbar.js).
-- `hud.show()` of a name it does not know falls back to the world, so pressing
-- the notification closed whatever was open and showed nothing.
--
-- db/0069's approve_submission, with that one word changed. Nothing about what
-- approving does is touched.

CREATE OR REPLACE FUNCTION approve_submission(p_id uuid, p_price numeric DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    s      submission%rowtype;
    a      area%rowtype;
    t      record;
    opened int := 0;
BEGIN
    SELECT * INTO s FROM submission WHERE id = p_id FOR UPDATE;
    IF s.id IS null THEN
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
                     jsonb_build_object('panel', 'Render jobs',
                                        'lon', st_x(st_pointonsurface(a.geom)),
                                        'lat', st_y(st_pointonsurface(a.geom))));
    END IF;
    RETURN jsonb_build_object('id', p_id, 'queued', opened);
END
$$;
