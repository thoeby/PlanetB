-- 0170_theworldrememberswhathappened.sql — what happened in the world, and
-- the one change that has to be said yes to.
--
-- TASKS-foundation.md FND.15, second half. Two things live here:
--
-- **Events.** A port changed, somebody clicked something, somebody arrived or
-- left. Nothing in v1 reads them — flows do, from F10 — but they are written
-- now, because an event nobody recorded is an event nobody can replay. The
-- page writes the three it is the only witness to, at most one a second per
-- player per thing, which is the difference between a record and a flood.
--
-- **Screens.** A billboard's `image` is somebody else's advertisement on
-- somebody's land, so db/0169 writes it as pending and this is where the
-- land's approver says yes. Approving it opens no render job: nothing baked
-- changed, and the splats are exactly what they were (D13).

CREATE TABLE world_event (
    id          bigserial PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    kind        text NOT NULL
                    CHECK (kind IN ('port_changed', 'click', 'enter', 'leave')),
    instance_id uuid REFERENCES instance (id) ON DELETE CASCADE,
    player_id   uuid REFERENCES auth.user (id),
    data        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX world_event_at_idx ON world_event (id);
CREATE INDEX world_event_thing_idx ON world_event (instance_id, id);

ALTER TABLE world_event ENABLE ROW LEVEL SECURITY;

-- The world is public to read. What was written is what happened.
CREATE POLICY readable ON world_event FOR SELECT TO anon, player, admin USING (true);
GRANT SELECT ON world_event TO anon, player, admin;

-- Invariant 6: nothing writes this table but the two functions below.

-- One a second per player per thing. A page that asks more often is not lying,
-- it is running at sixty frames; what it would record is the same event sixty
-- times, and the second one already says everything the first did.
CREATE FUNCTION record_event(p_kind text, p_instance uuid,
                             p_data jsonb DEFAULT '{}'::jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    mine uuid := current_user_id();
    id   bigint;
BEGIN
    IF mine IS NULL THEN
        RAISE EXCEPTION 'sign in first' USING errcode = '42501';
    END IF;
    IF p_kind NOT IN ('click', 'enter', 'leave') THEN
        RAISE EXCEPTION 'a page records what it saw somebody do, not "%"', p_kind
            USING errcode = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM world_event e
               WHERE e.player_id = mine AND e.kind = p_kind
                 AND e.instance_id IS NOT DISTINCT FROM p_instance
                 AND e.at > now() - interval '1 second') THEN
        RETURN null;
    END IF;
    INSERT INTO world_event (kind, instance_id, player_id, data)
    VALUES (p_kind, p_instance, mine, coalesce(p_data, '{}'::jsonb))
    RETURNING world_event.id INTO id;
    RETURN id;
END
$$;

GRANT EXECUTE ON FUNCTION record_event(text, uuid, jsonb) TO player, admin;

-- A port that changed is the world's own doing, not a page's, so it is written
-- where the change is made rather than asked for afterwards.
CREATE FUNCTION note_port_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
    IF tg_op = 'UPDATE' AND new.value IS NOT DISTINCT FROM old.value THEN
        RETURN new;
    END IF;
    INSERT INTO world_event (kind, instance_id, player_id, data)
    VALUES ('port_changed', new.instance_id, new.written_by,
            jsonb_build_object('port', new.port, 'value', new.value,
                               'rev', new.rev));
    RETURN new;
END
$$;

CREATE TRIGGER port_changed AFTER INSERT OR UPDATE ON live_state
FOR EACH ROW EXECUTE FUNCTION note_port_changed();

-- ---------------------------------------------------------------- screens

-- The screens waiting for me to say yes or no to, the way submissions_waiting
-- reads (db/0069): what it is, whose it is, and where to stand to see it.
CREATE FUNCTION screens_waiting() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, auth AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'instance', l.instance_id, 'port', l.port, 'pending', l.pending,
    'by', public.player_name(l.pending_by), 'at', l.at,
    'land', coalesce(a.rules ->> 'name', 'a land'), 'area', a.id,
    'lon', i.lon, 'lat', i.lat) ORDER BY l.at), '[]'::jsonb)
FROM live_state l
JOIN instance i ON i.id = l.instance_id AND i.deleted_at IS null
JOIN area a ON a.id = i.area_id
WHERE l.pending IS NOT NULL AND public.is_area_approver(a.id);
$$;

GRANT EXECUTE ON FUNCTION screens_waiting() TO player, admin;

-- Saying yes: what was pending becomes what the world shows. No job is opened
-- and no tile is marked — the splats are what they were, and only the picture
-- drawn over them changes (D13).
CREATE FUNCTION approve_screen(p_instance uuid, p_port text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    row  live_state%rowtype;
    area uuid;
BEGIN
    SELECT i.area_id INTO area FROM instance i
    WHERE i.id = p_instance AND i.deleted_at IS null;
    IF area IS NULL THEN
        RAISE EXCEPTION 'nothing of that name is standing anywhere'
            USING errcode = '23503';
    END IF;
    IF NOT is_area_approver(area) THEN
        RAISE EXCEPTION 'that is not yours to approve' USING errcode = '42501';
    END IF;
    UPDATE live_state SET value = pending, pending = null, pending_by = null,
                          rev = nextval('live_rev'), at = now()
    WHERE instance_id = p_instance AND port = p_port AND pending IS NOT NULL
    RETURNING * INTO row;
    IF row.instance_id IS NULL THEN
        RAISE EXCEPTION 'nothing is waiting on that screen' USING errcode = '23514';
    END IF;
    IF row.written_by <> current_user_id() THEN
        PERFORM tell(row.written_by, 'screen_approved',
                     player_name(current_user_id()) || ' approved what your screen shows',
                     jsonb_build_object('panel', 'Place', 'instance', p_instance));
    END IF;
    RETURN jsonb_build_object('instance', row.instance_id, 'port', row.port,
                              'value', row.value, 'rev', row.rev);
END
$$;

GRANT EXECUTE ON FUNCTION approve_screen(uuid, text) TO player, admin;

-- Saying no: the pending value is dropped and what is shown stays shown.
CREATE FUNCTION refuse_screen(p_instance uuid, p_port text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    area uuid;
    hit  int;
BEGIN
    SELECT i.area_id INTO area FROM instance i WHERE i.id = p_instance;
    IF area IS NULL OR NOT is_area_approver(area) THEN
        RAISE EXCEPTION 'that is not yours to approve' USING errcode = '42501';
    END IF;
    UPDATE live_state SET pending = null, pending_by = null, at = now()
    WHERE instance_id = p_instance AND port = p_port AND pending IS NOT NULL;
    GET DIAGNOSTICS hit = ROW_COUNT;
    RETURN hit > 0;
END
$$;

GRANT EXECUTE ON FUNCTION refuse_screen(uuid, text) TO player, admin;

-- Submit lists it with everything else a land has changed, because to the
-- person sending it that is what it is: a change other people will see. Every
-- other count here is db/0163's, unchanged — a screen is one more line on the
-- same list, not a reason to rewrite it.
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
    -- FND.15: a screen waiting for the land's approver (db/0169).
    'screens', (SELECT count(*) FROM live_state l
                JOIN instance i ON i.id = l.instance_id AND i.deleted_at IS null
                WHERE i.area_id = p_area AND l.pending IS NOT NULL),
    'features', (SELECT count(*) FROM feature f
                 WHERE f.area_id = p_area AND f.deleted_at IS null),
    'ground', coalesce((SELECT rev FROM current_height_edit(p_area)), 0),
    'kinds', coalesce((
        SELECT jsonb_object_agg(k.kind, k.n) FROM (
            SELECT f.kind, count(*) AS n FROM feature f
            WHERE f.area_id = p_area AND f.deleted_at IS null
            GROUP BY f.kind) k), '{}'::jsonb));
$$;

CREATE VIEW api.world_event WITH (security_invoker = true)
AS SELECT * FROM public.world_event;
GRANT SELECT ON api.world_event TO anon, player, admin;

CREATE FUNCTION api.record_event(p_kind text, p_instance uuid,
                                 p_data jsonb DEFAULT '{}'::jsonb) RETURNS bigint
LANGUAGE sql VOLATILE
AS $$SELECT public.record_event(p_kind, p_instance, p_data)$$;
CREATE FUNCTION api.screens_waiting() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.screens_waiting()$$;
CREATE FUNCTION api.approve_screen(p_instance uuid, p_port text) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.approve_screen(p_instance, p_port)$$;
CREATE FUNCTION api.refuse_screen(p_instance uuid, p_port text) RETURNS boolean
LANGUAGE sql VOLATILE AS $$SELECT public.refuse_screen(p_instance, p_port)$$;

GRANT EXECUTE ON FUNCTION api.record_event(text, uuid, jsonb),
    api.screens_waiting(), api.approve_screen(uuid, text),
    api.refuse_screen(uuid, text) TO player, admin;
