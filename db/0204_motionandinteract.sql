-- 0204_motionandinteract.sql — what the `interact` blocks ask the world.
--
-- TASKS-live.md LV.3. The `motion` blocks (client/flow/motion) are composites
-- over World's Write Port and need nothing new: a pose, a path and a spin are
-- ports since db/0200. Two of the `interact` blocks need an answer the world
-- did not give yet:
--
--   On Trigger  "was this thing set off this way since event N?" — the
--               events of one kind on one thing, not the whole land's, so a
--               flow built of blocks can wire the answer straight into a
--               motion's When (triggers_since).
--   Post        a line of words over a thing, for whoever stands near it
--               (post_note, and notes_near for the tabs that show it).
--
-- Give and Take are LV.4's (`give`, `take`); their composites are here
-- already, because a flow is a file and a file may name an address before
-- the world answers it — db/0168 did the same for the World blocks.

ALTER TABLE world_event DROP CONSTRAINT world_event_kind_check;
ALTER TABLE world_event ADD CONSTRAINT world_event_kind_check
CHECK (kind IN ('port_changed', 'click', 'enter', 'leave', 'trigger', 'post'));

-- One thing's firings of one kind after event N, read the way world_events
-- reads (db/0203): a flow key on its own land, a player on land they build on.
CREATE FUNCTION triggers_since(p_after bigint, p_instance uuid, p_kind text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    area uuid;
    rows jsonb;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'sign in first' USING errcode = '42501';
    END IF;
    SELECT i.area_id INTO area FROM instance i WHERE i.id = p_instance;
    IF area IS NULL OR NOT may_read_events(area) THEN
        RAISE EXCEPTION 'what happens there is not yours to read' USING errcode = '42501';
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id, 'at', e.at, 'player', public.player_name(e.player_id),
        'player_id', e.player_id, 'data', e.data) ORDER BY e.id), '[]'::jsonb)
    INTO rows
    FROM (SELECT * FROM world_event e
          WHERE e.id > coalesce(p_after, 0) AND e.instance_id = p_instance
            AND e.kind = 'trigger' AND e.data ->> 'trigger' = p_kind
          ORDER BY e.id LIMIT 100) e;
    RETURN jsonb_build_object('fired', jsonb_array_length(rows) > 0, 'events', rows,
        'last_id', coalesce((SELECT max((x ->> 'id')::bigint)
                             FROM jsonb_array_elements(rows) x), p_after, 0));
END
$$;

GRANT EXECUTE ON FUNCTION triggers_since(bigint, uuid, text) TO player, admin, flow;

-- Words over a thing. Whoever may set its ports may make it speak: the land's
-- builders, and a flow key on that land (db/0198 may_write_port).
CREATE FUNCTION post_note(p_instance uuid, p_text text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    said text := btrim(coalesce(p_text, ''));
    id   bigint;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'sign in first' USING errcode = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM instance WHERE instance.id = p_instance
                   AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'nothing of that name is standing anywhere' USING errcode = '23503';
    END IF;
    IF NOT may_write_port(p_instance) THEN
        RAISE EXCEPTION 'that is not your land' USING errcode = '42501';
    END IF;
    IF length(said) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'a note is between 1 and 200 characters' USING errcode = '22023';
    END IF;
    INSERT INTO world_event (kind, instance_id, player_id, data)
    VALUES ('post', p_instance, current_user_id(), jsonb_build_object('text', said))
    RETURNING world_event.id INTO id;
    RETURN id;
END
$$;

GRANT EXECUTE ON FUNCTION post_note(uuid, text) TO player, admin, flow;

-- What things near somebody said in the last ten minutes, after the note they
-- last saw. The world is public to read (db/0170): a sign says what it says to
-- whoever walks past.
CREATE FUNCTION notes_near(p_lon double precision, p_lat double precision,
                           p_metres double precision DEFAULT 200,
                           p_after bigint DEFAULT 0)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id, 'instance', e.instance_id, 'text', e.data ->> 'text',
    'name', coalesce(a.name, i.san)) ORDER BY e.id), '[]'::jsonb)
FROM world_event e
JOIN instance i ON i.id = e.instance_id AND i.deleted_at IS NULL
LEFT JOIN asset a ON a.san = i.san
WHERE e.kind = 'post' AND e.id > p_after AND e.at > now() - interval '10 minutes'
  AND st_dwithin(i.geom::geography,
                 st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography,
                 p_metres);
$$;

GRANT EXECUTE ON FUNCTION notes_near(double precision, double precision,
                                     double precision, bigint) TO anon, player, admin;

CREATE FUNCTION api.triggers_since(p_after bigint, p_instance uuid, p_kind text)
RETURNS jsonb LANGUAGE sql STABLE
AS $$SELECT public.triggers_since(p_after, p_instance, p_kind)$$;
CREATE FUNCTION api.post_note(p_instance uuid, p_text text) RETURNS bigint
LANGUAGE sql VOLATILE AS $$SELECT public.post_note(p_instance, p_text)$$;
CREATE FUNCTION api.notes_near(p_lon double precision, p_lat double precision,
                               p_metres double precision DEFAULT 200,
                               p_after bigint DEFAULT 0) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.notes_near(p_lon, p_lat, p_metres, p_after)$$;

GRANT EXECUTE ON FUNCTION api.triggers_since(bigint, uuid, text),
    api.post_note(uuid, text) TO player, admin, flow;
GRANT EXECUTE ON FUNCTION api.notes_near(double precision, double precision,
                                         double precision, bigint) TO anon, player, admin;
