-- 0203_productsdeclaretriggers.sql — a product says what sets it off, and
-- the world hears it once.
--
-- TASKS-live.md LV.2. A gate opens when somebody walks up to it; a bell rings
-- when it is clicked. The maker says which, in the register call:
--
--   asset.parts.triggers  [{"kind": "near", "params": {"m": 5}}, …]
--   asset.parts.rate      firings a minute, per placed one (default 30)
--
-- A trigger is `{kind, params}` and nothing else is checked here: the kinds
-- grow in built-in code (client/js/triggers.js) and never in a list in the
-- database. What a trigger does is a flow's, on a process server (Invariant
-- 9); the page only notices that it happened and says so once, through
-- `emit_trigger`, which the world refuses above the product's rate.
--
-- `world_events` answered nobody (db/0168). It answers now: a flow key the
-- events on its own land, a player the events on land they build on.

-- ------------------------------------------------------------- the markings

-- A product with a trigger and no part is still a product with markings.
CREATE OR REPLACE FUNCTION has_marks(p_parts jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
SELECT coalesce(jsonb_array_length(p_parts -> 'parts'), 0) > 0
    OR coalesce(jsonb_array_length(p_parts -> 'openings'), 0) > 0
    OR coalesce(jsonb_array_length(p_parts -> 'triggers'), 0) > 0;
$$;

-- Shape only: a kind is a word, its params an object, the rate a number.
CREATE FUNCTION check_triggers(p_parts jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    t jsonb;
BEGIN
    IF p_parts -> 'triggers' IS NOT NULL AND jsonb_typeof(p_parts -> 'triggers') <> 'array' THEN
        RAISE EXCEPTION 'triggers are a list: [{"kind": "click", "params": {}}]';
    END IF;
    FOR t IN SELECT * FROM jsonb_array_elements(coalesce(p_parts -> 'triggers', '[]')) LOOP
        IF jsonb_typeof(t) <> 'object' OR NOT marks_token(t ->> 'kind') THEN
            RAISE EXCEPTION '"%" is not a kind of trigger', coalesce(t ->> 'kind', t::text);
        END IF;
        IF coalesce(jsonb_typeof(t -> 'params'), 'object') <> 'object' THEN
            RAISE EXCEPTION 'a % trigger''s params are {…}', t ->> 'kind';
        END IF;
    END LOOP;
    IF p_parts -> 'rate' IS NOT NULL AND (jsonb_typeof(p_parts -> 'rate') <> 'number'
        OR (p_parts ->> 'rate')::numeric NOT BETWEEN 1 AND 600) THEN
        RAISE EXCEPTION 'a thing is set off between 1 and 600 times a minute';
    END IF;
END
$$;

-- db/0200's check_marks, with the triggers checked beside the parts.
CREATE OR REPLACE FUNCTION check_marks(p_parts jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    m     jsonb;
    names text [] := '{}';
BEGIN
    IF NOT has_marks(p_parts) THEN RETURN; END IF;
    FOR m IN SELECT * FROM jsonb_array_elements(coalesce(p_parts -> 'parts', '[]')) LOOP
        IF NOT marks_token(m ->> 'name') THEN
            RAISE EXCEPTION '"%" is not a name a part may have', m ->> 'name';
        END IF;
        IF m ->> 'name' = ANY (names) THEN
            RAISE EXCEPTION 'there are two parts called %', m ->> 'name';
        END IF;
        names := names || (m ->> 'name');
        IF (m ->> 'role') NOT IN ('light', 'screen', 'door', 'rotor', 'joint') THEN
            RAISE EXCEPTION '% needs a role', m ->> 'name';
        END IF;
        IF NOT marks_token(m ->> 'node') THEN
            RAISE EXCEPTION '"%" is not a node this model can have', m ->> 'node';
        END IF;
    END LOOP;
    FOR m IN SELECT * FROM jsonb_array_elements(coalesce(p_parts -> 'openings', '[]')) LOOP
        IF NOT marks_token(m ->> 'name') OR NOT marks_token(m ->> 'node') THEN
            RAISE EXCEPTION '"%" is not a name an opening may have', m ->> 'name';
        END IF;
    END LOOP;
    PERFORM check_ports(p_parts, names);
    PERFORM check_triggers(p_parts);
END
$$;

-- db/0160's canonical text, with a line per trigger and the rate. A gate that
-- opens at five metres and one that opens at ten are two products. A params
-- object is written as jsonb writes it, which is one spelling for one value.
CREATE OR REPLACE FUNCTION marks_text(p_parts jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE WHEN NOT has_marks(p_parts) THEN ''
    ELSE coalesce((
        SELECT string_agg(line, '' ORDER BY line) FROM (
            SELECT 'part:' || (m ->> 'name') || ':' || (m ->> 'node') || ':'
                || (m ->> 'role') || ':' || CASE m ->> 'role'
                    WHEN 'light' THEN coalesce(m ->> 'colour', '#ffd9a0') || ':'
                        || marks_num(m -> 'intensity', 1)
                    WHEN 'screen' THEN marks_num(m -> 'aspect', 1.778)
                    ELSE coalesce(m ->> 'axis', 'y') || ':' || marks_num(m -> 'range', 90)
                END || E'\n' AS line
            FROM jsonb_array_elements(coalesce(p_parts -> 'parts', '[]')) m
            UNION ALL
            SELECT 'port:' || (m ->> 'name') || ':' || (m ->> 'type') || ':'
                || coalesce(m ->> 'default', '') || ':' || (m #>> '{drives,part}')
                || '.' || coalesce(m #>> '{drives,what}', '') || E'\n'
            FROM jsonb_array_elements(coalesce(p_parts -> 'ports', '[]')) m
            UNION ALL
            SELECT 'open:' || (m ->> 'name') || ':' || (m ->> 'node') || E'\n'
            FROM jsonb_array_elements(coalesce(p_parts -> 'openings', '[]')) m
            UNION ALL
            SELECT 'trig:' || (t ->> 'kind') || ':'
                || coalesce(t -> 'params', '{}'::jsonb)::text || E'\n'
            FROM jsonb_array_elements(coalesce(p_parts -> 'triggers', '[]')) t
            UNION ALL
            SELECT 'rate:' || marks_num(p_parts -> 'rate', 30) || E'\n'
            WHERE p_parts ? 'rate'
        ) lines), '')
END;
$$;

GRANT EXECUTE ON FUNCTION check_triggers(jsonb) TO anon, player, admin;

-- ---------------------------------------------------------------- firing

ALTER TABLE world_event DROP CONSTRAINT world_event_kind_check;
ALTER TABLE world_event ADD CONSTRAINT world_event_kind_check
CHECK (kind IN ('port_changed', 'click', 'enter', 'leave', 'trigger'));

-- The trigger of that kind a product declares, or null. For `use`, the one
-- about that part.
CREATE FUNCTION trigger_of(p_san text, p_kind text, p_part text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT t FROM asset a, jsonb_array_elements(coalesce(a.parts -> 'triggers', '[]')) t
WHERE a.san = p_san AND t ->> 'kind' = p_kind
  AND (p_part IS NULL OR coalesce(t #>> '{params,part}', p_part) = p_part)
LIMIT 1;
$$;

-- One firing, said once by the tab that saw it. Refused for a kind the
-- product never declared, and above the product's rate: a page that fires
-- sixty times a second is not sixty events.
CREATE FUNCTION emit_trigger(p_instance uuid, p_kind text, p_part text DEFAULT NULL,
                             p_clock double precision DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    mine uuid := current_user_id();
    inst instance%ROWTYPE;
    decl jsonb;
    rate int;
    id   bigint;
BEGIN
    IF mine IS NULL THEN
        RAISE EXCEPTION 'sign in first' USING errcode = '42501';
    END IF;
    SELECT * INTO inst FROM instance WHERE instance.id = p_instance AND deleted_at IS NULL;
    IF inst.id IS NULL THEN
        RAISE EXCEPTION 'nothing of that name is standing anywhere' USING errcode = '23503';
    END IF;
    decl := trigger_of(inst.san, p_kind, p_part);
    IF decl IS NULL THEN
        RAISE EXCEPTION '% is not set off by %', inst.san, p_kind USING errcode = '22023';
    END IF;
    SELECT coalesce((parts ->> 'rate')::int, 30) INTO rate FROM asset WHERE san = inst.san;
    -- Serialises firings of one thing, so two tabs at the limit are counted.
    PERFORM 1 FROM instance WHERE instance.id = p_instance FOR UPDATE;
    IF (SELECT count(*) FROM world_event e
        WHERE e.instance_id = p_instance AND e.kind = 'trigger'
          AND e.at > now() - interval '1 minute') >= rate THEN
        RAISE EXCEPTION 'this is set off at most % times a minute', rate
            USING errcode = '54000';
    END IF;
    INSERT INTO world_event (kind, instance_id, player_id, data)
    VALUES ('trigger', p_instance, mine, jsonb_build_object(
        'trigger', p_kind, 'part', p_part, 'params', coalesce(decl -> 'params', '{}'),
        'clock', coalesce(p_clock, world_clock())))
    RETURNING world_event.id INTO id;
    RETURN id;
END
$$;

GRANT EXECUTE ON FUNCTION trigger_of(text, text, text) TO anon, player, admin;
GRANT EXECUTE ON FUNCTION emit_trigger(uuid, text, text, double precision) TO player, admin;

-- ----------------------------------------------------------------- reading

-- Whose events the caller may read: a flow key its own land's (db/0198), a
-- player the lands they build on. Not the whole world's: who walked where is
-- the land's business.
CREATE FUNCTION may_read_events(p_area uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT CASE WHEN current_user_role() = 'flow' THEN flow_key_reaches(p_area)
    ELSE is_area_proposer(p_area) END
$$;

CREATE OR REPLACE FUNCTION world_events(p_after bigint DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    rows jsonb;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'sign in first' USING errcode = '42501';
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id, 'at', e.at, 'kind', e.kind, 'instance', e.instance_id,
        'player', public.player_name(e.player_id), 'data', e.data) ORDER BY e.id),
        '[]'::jsonb)
    INTO rows
    FROM (SELECT e.* FROM world_event e JOIN instance i ON i.id = e.instance_id
          WHERE e.id > coalesce(p_after, 0) AND may_read_events(i.area_id)
          ORDER BY e.id LIMIT 500) e;
    RETURN jsonb_build_object('events', rows,
        'last_id', coalesce((SELECT max((x ->> 'id')::bigint)
                             FROM jsonb_array_elements(rows) x), p_after, 0));
END
$$;

GRANT EXECUTE ON FUNCTION may_read_events(uuid) TO player, admin, flow;
GRANT EXECUTE ON FUNCTION world_events(bigint) TO flow;
GRANT EXECUTE ON FUNCTION api.world_events(bigint) TO flow;
GRANT EXECUTE ON FUNCTION flow_key_reaches(uuid) TO flow;

CREATE FUNCTION api.emit_trigger(p_instance uuid, p_kind text, p_part text DEFAULT NULL,
                                 p_clock double precision DEFAULT NULL) RETURNS bigint
LANGUAGE sql VOLATILE
AS $$SELECT public.emit_trigger(p_instance, p_kind, p_part, p_clock)$$;
GRANT EXECUTE ON FUNCTION api.emit_trigger(uuid, text, text, double precision)
TO player, admin;
