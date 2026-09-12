-- 0063_landrequests.sql — asking for land, and being told you have it.
--
-- SPEC §3.2: land is assigned by an admin. A player with none asks, saying
-- what they want it for; an admin draws the boundary and hands it over; the
-- player is told. Until now the only way to get land was to draw it yourself
-- in QGIS, which is neither what the spec says nor something an operator can
-- hold a world together with.
--
-- The notification table is the whole of SPEC §2.15's delivery: one row per
-- thing waiting for one person, with the words already in it and enough to go
-- to the thing. Nothing here decides what is worth telling somebody; the
-- functions that change the world do.

CREATE TABLE notification (
    id         bigserial PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES auth.user (id) ON DELETE CASCADE,
    kind       text NOT NULL,
    words      text NOT NULL,
    goes_to    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    seen_at    timestamptz
);

CREATE INDEX notification_waiting ON notification (user_id, seen_at);

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;

-- Invariant 6: yours to read and to mark read, nobody's to write. Only the
-- SECURITY DEFINER functions below put rows in.
CREATE POLICY mine_to_read ON notification FOR SELECT TO player, admin
    USING (user_id = current_user_id());
CREATE POLICY mine_to_mark ON notification FOR UPDATE TO player, admin
    USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());

GRANT SELECT, UPDATE ON notification TO player, admin;

CREATE FUNCTION tell(who uuid, kind text, words text,
                     goes_to jsonb DEFAULT '{}'::jsonb) RETURNS bigint
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
INSERT INTO notification (user_id, kind, words, goes_to)
VALUES (who, kind, words, goes_to) RETURNING id;
$$;

CREATE FUNCTION my_notifications(only_waiting boolean DEFAULT true) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(n ORDER BY n ->> 'at' DESC), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object('id', id, 'kind', kind, 'words', words,
                              'goes_to', goes_to, 'at', created_at,
                              'seen', seen_at IS NOT null) AS n
    FROM notification
    WHERE user_id = current_user_id()
      AND (NOT only_waiting OR seen_at IS null)
    ORDER BY created_at DESC
    LIMIT 50
) q;
$$;

GRANT EXECUTE ON FUNCTION my_notifications(boolean) TO player, admin;

CREATE FUNCTION mark_seen(n_id bigint DEFAULT null) RETURNS int
LANGUAGE sql VOLATILE SET search_path = public AS $$
UPDATE notification SET seen_at = now()
WHERE user_id = current_user_id() AND seen_at IS null
  AND (n_id IS null OR id = n_id)
RETURNING 1;
$$;

GRANT EXECUTE ON FUNCTION mark_seen(bigint) TO player, admin;

-- ------------------------------------------------------------ land requests

CREATE TABLE land_request (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id  uuid NOT NULL REFERENCES auth.user (id) ON DELETE CASCADE,
    note       text NOT NULL DEFAULT '',
    state      text NOT NULL DEFAULT 'open'
                   CHECK (state IN ('open', 'assigned', 'refused')),
    area_id    uuid REFERENCES area (id) ON DELETE SET null,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz
);

ALTER TABLE land_request ENABLE ROW LEVEL SECURITY;

CREATE POLICY mine_to_read ON land_request FOR SELECT TO player, admin
    USING (player_id = current_user_id() OR current_user_role() = 'admin');

GRANT SELECT ON land_request TO player, admin;

CREATE FUNCTION request_land(note text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    uid uuid := current_user_id();
    rid uuid;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'sign in before you ask for land' USING errcode = '28000';
    END IF;
    SELECT id INTO rid FROM land_request
    WHERE player_id = uid AND state = 'open' LIMIT 1;
    IF rid IS NOT null THEN
        UPDATE land_request SET note = request_land.note WHERE id = rid;
    ELSE
        INSERT INTO land_request (player_id, note) VALUES (uid, note)
        RETURNING id INTO rid;
    END IF;
    -- Every admin, because any of them may be the one who is looking.
    PERFORM tell(u.id, 'land_requested',
                 player_name(uid) || ' asked for land: '
                 || coalesce(nullif(btrim(note), ''), '(no note)'),
                 jsonb_build_object('panel', 'Admin', 'request', rid))
    FROM auth.user u WHERE u.role = 'admin';
    RETURN jsonb_build_object('id', rid, 'note', note, 'state', 'open');
END
$$;

GRANT EXECUTE ON FUNCTION request_land(text) TO player, admin;

-- What is waiting: the queue for an admin, your own for everybody else. Both
-- panels ask the same question and the answer is what you may see — the
-- table's policy says the same thing about the rows themselves.
CREATE FUNCTION land_requests(which text DEFAULT 'open') RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, auth AS $$
SELECT coalesce(jsonb_agg(r ORDER BY r ->> 'at'), '[]'::jsonb)
FROM (
    SELECT jsonb_build_object('id', lr.id, 'player_id', lr.player_id,
                              'who', player_name(lr.player_id),
                              'note', lr.note, 'state', lr.state,
                              'mine', lr.player_id = current_user_id(),
                              'at', lr.created_at, 'area_id', lr.area_id) AS r
    FROM land_request lr
    WHERE (current_user_role() = 'admin' OR lr.player_id = current_user_id())
      AND (which = 'all' OR lr.state = which)
) q;
$$;

GRANT EXECUTE ON FUNCTION land_requests(text) TO player, admin;

-- Hand the land over: the area is the requester's, not the admin's, so
-- create_area's "owner is whoever called it" is not what happens here.
CREATE FUNCTION assign_land(request_id uuid, geojson jsonb, name text,
                            detail int DEFAULT 14) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    req  land_request;
    g    geometry;
    aid  uuid;
BEGIN
    IF current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin assigns land' USING errcode = '42501';
    END IF;
    SELECT * INTO req FROM land_request WHERE id = request_id;
    IF req.id IS NULL THEN
        RAISE EXCEPTION 'there is no such request' USING errcode = '23503';
    END IF;
    IF req.state <> 'open' THEN
        RAISE EXCEPTION 'that request was already %', req.state
            USING errcode = '23514';
    END IF;
    IF btrim(coalesce(name, '')) = '' THEN
        RAISE EXCEPTION 'land needs a name — it is what everyone will call it'
            USING errcode = '23514';
    END IF;
    BEGIN
        g := st_setsrid(st_geomfromgeojson(geojson), world_srid());
    EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'that is not GeoJSON geometry: %', sqlerrm;
    END;
    IF st_geometrytype(g) <> 'ST_Polygon' THEN
        RAISE EXCEPTION 'land is one polygon, not %', st_geometrytype(g);
    END IF;
    IF NOT st_isvalid(g) THEN
        RAISE EXCEPTION 'that outline is not valid: %', st_isvalidreason(g);
    END IF;
    PERFORM refuse_outside_ground(g, btrim(name));

    INSERT INTO area (geom, owner_id, detail, rules)
    VALUES (g, req.player_id, detail,
            jsonb_build_object('required_approvals', 1, 'name', btrim(name)))
    RETURNING area.id INTO aid;

    UPDATE land_request SET state = 'assigned', area_id = aid, decided_at = now()
    WHERE id = request_id;

    PERFORM tell(req.player_id, 'land_assigned',
                 btrim(name) || ' is yours — ' || player_name(current_user_id())
                 || ' assigned it',
                 jsonb_build_object('panel', 'Your land', 'area', aid,
                                    'lon', st_x(st_pointonsurface(g)),
                                    'lat', st_y(st_pointonsurface(g))));
    RETURN jsonb_build_object('area_id', aid, 'name', btrim(name),
                              'who', player_name(req.player_id));
END
$$;

GRANT EXECUTE ON FUNCTION assign_land(uuid, jsonb, text, int) TO admin;

-- Who to ask, for a player with no land (SPEC §2.4 "Get land").
CREATE FUNCTION admins() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
SELECT coalesce(jsonb_agg(player_name(id) ORDER BY created_at), '[]'::jsonb)
FROM auth.user WHERE role = 'admin';
$$;

GRANT EXECUTE ON FUNCTION admins() TO anon, player, admin;

CREATE FUNCTION api.my_notifications(only_waiting boolean DEFAULT true) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.my_notifications(only_waiting)$$;
GRANT EXECUTE ON FUNCTION api.my_notifications(boolean) TO player, admin;

CREATE FUNCTION api.mark_seen(n_id bigint DEFAULT null) RETURNS int
LANGUAGE sql VOLATILE AS $$SELECT public.mark_seen(n_id)$$;
GRANT EXECUTE ON FUNCTION api.mark_seen(bigint) TO player, admin;

CREATE FUNCTION api.request_land(note text DEFAULT '') RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.request_land(note)$$;
GRANT EXECUTE ON FUNCTION api.request_land(text) TO player, admin;

CREATE FUNCTION api.land_requests(which text DEFAULT 'open') RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.land_requests(which)$$;
GRANT EXECUTE ON FUNCTION api.land_requests(text) TO player, admin;

CREATE FUNCTION api.assign_land(request_id uuid, geojson jsonb, name text,
                                detail int DEFAULT 14) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.assign_land(request_id, geojson, name, detail)$$;
GRANT EXECUTE ON FUNCTION api.assign_land(uuid, jsonb, text, int) TO admin;

CREATE FUNCTION api.admins() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.admins()$$;
GRANT EXECUTE ON FUNCTION api.admins() TO anon, player, admin;

-- PUBLIC gets EXECUTE on a new function unless it is taken away, and `tell`
-- writes a row into somebody else's notifications: anon could forge one to
-- anybody. It is nobody's to call but the functions above, which are SECURITY
-- DEFINER and owned by the schema.
REVOKE ALL ON FUNCTION tell(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION my_notifications(boolean), mark_seen(bigint),
    request_land(text), land_requests(text), assign_land(uuid, jsonb, text, int),
    admins(), api.my_notifications(boolean), api.mark_seen(bigint),
    api.request_land(text), api.land_requests(text),
    api.assign_land(uuid, jsonb, text, int), api.admins() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_notifications(boolean), mark_seen(bigint),
    request_land(text), land_requests(text), api.my_notifications(boolean),
    api.mark_seen(bigint), api.request_land(text), api.land_requests(text)
    TO player, admin;
GRANT EXECUTE ON FUNCTION assign_land(uuid, jsonb, text, int),
    api.assign_land(uuid, jsonb, text, int) TO admin;
GRANT EXECUTE ON FUNCTION admins(), api.admins() TO anon, player, admin;
