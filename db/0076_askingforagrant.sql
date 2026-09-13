-- 0076_askingforagrant.sql — asking to build on somebody else's land.
--
-- SPEC §3.11: standing on Anna's land, Ben asks for a build grant with a note;
-- Anna is told, sees it on the land's card, and gives it; Ben is told and may
-- build there. Giving has existed since db/0022_proposals.sql (set_grant, by
-- email, from the owner's own panel) — asking has not, so the only way to be
-- given anything was to reach the owner outside the world and have them type
-- your address.
--
-- The same shape as db/0063_landrequests.sql: a row per ask, a notification
-- with the words already in it, and the decision as one function that both
-- writes the grant and says so.

CREATE TABLE grant_request (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id    uuid NOT NULL REFERENCES area (id) ON DELETE CASCADE,
    asker_id   uuid NOT NULL REFERENCES auth.user (id) ON DELETE CASCADE,
    right_     text NOT NULL DEFAULT 'direct_edit'
                   CHECK (right_ IN ('edit', 'direct_edit', 'approve')),
    note       text NOT NULL DEFAULT '',
    state      text NOT NULL DEFAULT 'open'
                   CHECK (state IN ('open', 'given', 'refused')),
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz,
    decided_by uuid REFERENCES auth.user (id)
);

CREATE INDEX grant_request_open ON grant_request (area_id, state);

ALTER TABLE grant_request ENABLE ROW LEVEL SECURITY;

-- Invariant 6: the person who asked and the owner who has to answer, nobody
-- else. The functions below are what write.
CREATE POLICY mine_to_read ON grant_request FOR SELECT TO player, admin
    USING (asker_id = current_user_id() OR is_area_owner(area_id)
           OR current_user_role() = 'admin');

GRANT SELECT ON grant_request TO player, admin;

-- What one right is called when it is asked for and when it is given.
CREATE FUNCTION right_words(p_right text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE p_right
    WHEN 'direct_edit' THEN 'build on'
    WHEN 'edit' THEN 'propose changes to'
    WHEN 'approve' THEN 'approve what is built on'
    ELSE p_right END;
$$;

CREATE FUNCTION request_grant(p_area uuid, p_right text DEFAULT 'direct_edit',
                              p_note text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    uid uuid := current_user_id();
    a   area%rowtype;
    rid uuid;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'sign in before you ask' USING errcode = '28000';
    END IF;
    SELECT * INTO a FROM area WHERE id = p_area;
    IF a.id IS NULL THEN
        RAISE EXCEPTION 'no such land' USING errcode = '23503';
    END IF;
    IF a.owner_id = uid THEN
        RAISE EXCEPTION 'that is your own land' USING errcode = '23514';
    END IF;
    IF has_area_right(p_area, p_right) THEN
        RAISE EXCEPTION 'you may already % that land', right_words(p_right)
            USING errcode = '23514';
    END IF;

    -- Asking twice is the same ask with a better note, not a second queue
    -- entry for the owner to answer twice.
    SELECT id INTO rid FROM grant_request
    WHERE area_id = p_area AND asker_id = uid AND right_ = p_right
      AND state = 'open';
    IF rid IS NOT null THEN
        UPDATE grant_request SET note = coalesce(p_note, '') WHERE id = rid;
    ELSE
        INSERT INTO grant_request (area_id, asker_id, right_, note)
        VALUES (p_area, uid, p_right, coalesce(p_note, ''))
        RETURNING id INTO rid;
    END IF;

    PERFORM tell(a.owner_id, 'grant_requested',
                 player_name(uid) || ' asked to ' || right_words(p_right) || ' '
                 || coalesce(a.rules ->> 'name', 'your land')
                 || CASE WHEN btrim(coalesce(p_note, '')) = '' THEN ''
                         ELSE ': ' || btrim(p_note) END,
                 jsonb_build_object('panel', 'Your land', 'area', p_area,
                                    'request', rid));
    RETURN jsonb_build_object('id', rid, 'state', 'open', 'right', p_right);
END
$$;

GRANT EXECUTE ON FUNCTION request_grant(uuid, text, text) TO player, admin;

-- What is waiting on one piece of land: the owner's queue, and the asker's own
-- ask so they can see it is still waiting.
CREATE FUNCTION grant_requests(p_area uuid DEFAULT null) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, auth AS $$
SELECT coalesce(jsonb_agg(r ORDER BY r ->> 'at'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object(
        'id', gr.id, 'area_id', gr.area_id,
        'land', coalesce(a.rules ->> 'name', 'unnamed land'),
        'who', player_name(gr.asker_id), 'asker_id', gr.asker_id,
        'right', gr.right_, 'words', right_words(gr.right_),
        'note', gr.note, 'state', gr.state,
        'mine', gr.asker_id = current_user_id(),
        'at', gr.created_at) AS r
    FROM grant_request gr
    JOIN area a ON a.id = gr.area_id
    WHERE gr.state = 'open'
      AND (p_area IS NULL OR gr.area_id = p_area)
      AND (gr.asker_id = current_user_id() OR is_area_owner(gr.area_id))
) q;
$$;

GRANT EXECUTE ON FUNCTION grant_requests(uuid) TO player, admin;

-- Yes. The grant is written and the person who asked is told, in one
-- transaction: a grant nobody knows they have is a grant nobody uses.
CREATE FUNCTION give_grant(p_request uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    r grant_request%rowtype;
    a area%rowtype;
BEGIN
    SELECT * INTO r FROM grant_request WHERE id = p_request FOR UPDATE;
    IF r.id IS NULL THEN
        RAISE EXCEPTION 'no such request' USING errcode = '23503';
    END IF;
    IF NOT is_area_owner(r.area_id) THEN
        RAISE EXCEPTION 'only the owner gives on their own land'
            USING errcode = '42501';
    END IF;
    IF r.state <> 'open' THEN
        RAISE EXCEPTION 'that was already %', r.state USING errcode = '23514';
    END IF;
    SELECT * INTO a FROM area WHERE id = r.area_id;

    INSERT INTO grant_ (area_id, grantee_id, right_)
    VALUES (r.area_id, r.asker_id, r.right_) ON CONFLICT DO NOTHING;
    UPDATE grant_request SET state = 'given', decided_at = now(),
                             decided_by = current_user_id()
    WHERE id = p_request;

    PERFORM tell(r.asker_id, 'grant_given',
                 player_name(a.owner_id) || ' says you may '
                 || right_words(r.right_) || ' '
                 || coalesce(a.rules ->> 'name', 'their land'),
                 jsonb_build_object('panel', 'Place', 'area', r.area_id,
                                    'lon', st_x(st_pointonsurface(a.geom)),
                                    'lat', st_y(st_pointonsurface(a.geom))));
    RETURN jsonb_build_object('id', p_request, 'state', 'given',
                              'right', r.right_);
END
$$;

GRANT EXECUTE ON FUNCTION give_grant(uuid) TO player, admin;

CREATE FUNCTION api.request_grant(area_id uuid, right_ text DEFAULT 'direct_edit',
                                  note text DEFAULT '') RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.request_grant(area_id, right_, note)$$;

CREATE FUNCTION api.grant_requests(area_id uuid DEFAULT null) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.grant_requests(area_id)$$;

CREATE FUNCTION api.give_grant(request_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.give_grant(request_id)$$;

REVOKE ALL ON FUNCTION right_words(text), api.request_grant(uuid, text, text),
    api.grant_requests(uuid), api.give_grant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION right_words(text) TO anon, player, admin;
GRANT EXECUTE ON FUNCTION api.request_grant(uuid, text, text),
    api.grant_requests(uuid), api.give_grant(uuid) TO player, admin;
