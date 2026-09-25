-- 0205_anobjectmaybeheld.sql — a thing may be picked up, carried, handed
-- on and put down again.
--
-- TASKS-live.md LV.4. A crate is somewhere on the ground, or in somebody's
-- hands, or in a chest — never two of those at once. So a held thing has no
-- position at all: `lon`/`lat` are null while `holder_player` or
-- `holder_instance` says who has it, and every spatial question the world
-- already asks (tiles, what is near, what a tile is built of) passes it by
-- without being told.
--
-- A product says it may be carried (`parts.carry {kind}`) or that it holds
-- things (`parts.hold {capacity, kinds}`). A carried thing is never baked
-- into a tile — it would still be in the splats after somebody walked off
-- with it — and moving it dirties nothing (Invariant 4 holds: nothing to
-- compile, nothing marked). It still answers its ports.
--
-- `take`, `drop` and `give` are each one compare-and-swap on the holder: two
-- people reaching for the same crate are one who has it and one who is told
-- who does.

-- ------------------------------------------------------------ the markings

CREATE OR REPLACE FUNCTION has_marks(p_parts jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
SELECT coalesce(jsonb_array_length(p_parts -> 'parts'), 0) > 0
    OR coalesce(jsonb_array_length(p_parts -> 'openings'), 0) > 0
    OR coalesce(jsonb_array_length(p_parts -> 'triggers'), 0) > 0
    OR p_parts ? 'carry' OR p_parts ? 'hold';
$$;

CREATE FUNCTION check_holding(p_parts jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    k jsonb;
BEGIN
    IF p_parts ? 'carry' AND (jsonb_typeof(p_parts -> 'carry') <> 'object'
        OR NOT marks_token(coalesce(p_parts #>> '{carry,kind}', 'thing'))) THEN
        RAISE EXCEPTION 'a thing that may be carried says what kind of thing it is:'
                        ' {"kind": "crate"}';
    END IF;
    IF p_parts ? 'hold' THEN
        IF jsonb_typeof(p_parts #> '{hold,capacity}') IS DISTINCT FROM 'number'
           OR (p_parts #>> '{hold,capacity}')::numeric NOT BETWEEN 1 AND 1000 THEN
            RAISE EXCEPTION 'a container holds between 1 and 1000 things';
        END IF;
        FOR k IN SELECT * FROM jsonb_array_elements(coalesce(p_parts #> '{hold,kinds}', '[]'))
        LOOP
            IF NOT marks_token(k #>> '{}') THEN
                RAISE EXCEPTION '"%" is not a kind of thing', k #>> '{}';
            END IF;
        END LOOP;
    END IF;
END
$$;

-- db/0203's check_marks, with carrying and holding checked beside the rest.
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
    PERFORM check_holding(p_parts);
END
$$;

-- db/0203's canonical text, with a line for carrying and one for holding.
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
            UNION ALL
            SELECT 'carry:' || coalesce(p_parts #>> '{carry,kind}', 'thing') || E'\n'
            WHERE p_parts ? 'carry'
            UNION ALL
            SELECT 'hold:' || marks_num(p_parts #> '{hold,capacity}', 1) || ':'
                || coalesce((SELECT string_agg(k, ',' ORDER BY k)
                             FROM jsonb_array_elements_text(p_parts #> '{hold,kinds}') k), '')
                || E'\n'
            WHERE p_parts ? 'hold'
        ) lines), '')
END;
$$;

GRANT EXECUTE ON FUNCTION check_holding(jsonb) TO anon, player, admin;

-- ---------------------------------------------------------------- holding

ALTER TABLE instance ALTER COLUMN lon DROP NOT NULL;
ALTER TABLE instance ALTER COLUMN lat DROP NOT NULL;
ALTER TABLE instance
ADD COLUMN holder_player uuid REFERENCES auth.user (id),
ADD COLUMN holder_instance uuid REFERENCES instance (id),
-- Whether its product may be carried, kept on the row so the dirtying
-- trigger can ask it without reading another table (set below).
ADD COLUMN carry boolean NOT NULL DEFAULT false,
ADD CONSTRAINT instance_one_holder
    CHECK (holder_player IS NULL OR holder_instance IS NULL),
-- Somewhere, or in somebody's hands, or in something: exactly one.
ADD CONSTRAINT instance_held_or_placed
    CHECK ((lon IS NULL) = (holder_player IS NOT NULL OR holder_instance IS NOT NULL)
           AND (lon IS NULL) = (lat IS NULL));
CREATE INDEX instance_holder_player_idx ON instance (holder_player)
WHERE holder_player IS NOT NULL;
CREATE INDEX instance_holder_instance_idx ON instance (holder_instance)
WHERE holder_instance IS NOT NULL;

CREATE FUNCTION instance_carry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    new.carry := coalesce((SELECT a.parts ? 'carry' FROM asset a WHERE a.san = new.san), false);
    RETURN new;
END
$$;
-- On every write, so nobody sets it by hand: it is the product's to say.
CREATE TRIGGER instance_1_carry BEFORE INSERT OR UPDATE ON instance
FOR EACH ROW EXECUTE FUNCTION instance_carry();
UPDATE instance i SET carry = true FROM asset a WHERE a.san = i.san AND a.parts ? 'carry';

-- Invariant 4, narrowed: a thing that may be carried is never baked, so
-- putting it down or picking it up marks no tile.
DROP TRIGGER instance_dirty ON instance;
CREATE TRIGGER instance_dirty AFTER INSERT OR UPDATE ON instance
FOR EACH ROW WHEN (NOT new.carry) EXECUTE FUNCTION mark_tiles_dirty();
CREATE TRIGGER instance_dirty_gone AFTER DELETE ON instance
FOR EACH ROW WHEN (NOT old.carry) EXECUTE FUNCTION mark_tiles_dirty();

-- db/0167's tile_world, without the things that may be carried: what the
-- compiler bakes is what stays where it was put.
CREATE OR REPLACE FUNCTION tile_world(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT SET search_path = public AS $$
SELECT jsonb_build_object(
    'z', z, 'x', x, 'y', y,
    'snapshot', world_snapshot(z, x, y),
    'symbols', pinned_symbols(),
    'symbol_files', symbol_files(),
    'height_edits', height_edits(z, x, y),
    'cover', pinned_cover(),
    'lands', tile_lands(z, x, y),
    'features', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'id', f.id, 'kind', f.kind, 'rev', f.rev, 'props', f.props,
            'geom', st_asgeojson(f.geom, 12)::jsonb) ORDER BY f.id)
        FROM feature f
        WHERE f.deleted_at IS NULL
          AND st_intersects(f.geom, tile_bbox(z, x, y))), '[]'::jsonb),
    'instances', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'id', i.id, 'san', i.san, 'rev', i.rev, 'props', i.props,
            'sha256', a.sha256, 'canon_version', a.canon_version, 'parts', a.parts,
            'lon', i.lon, 'lat', i.lat, 'h', i.h,
            'yaw', i.yaw, 'pitch', i.pitch, 'roll', i.roll,
            'scale', i.scale) ORDER BY i.id)
        FROM instance i
        JOIN asset a ON a.san = i.san
        WHERE i.deleted_at IS NULL AND NOT i.carry
          AND st_intersects(i.geom, tile_bbox(z, x, y))), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------- the verbs

-- Who has a thing, in the words somebody reaching for it is told.
CREATE FUNCTION holder_words(i instance) RETURNS text
LANGUAGE sql STABLE SET search_path = public, auth AS $$
SELECT CASE
    WHEN i.holder_player = current_user_id() THEN 'You already have it.'
    WHEN i.holder_player IS NOT NULL
        THEN player_name(i.holder_player) || ' has it.'
    WHEN i.holder_instance IS NOT NULL THEN 'It is in '
        || coalesce((SELECT a.name FROM instance c JOIN asset a ON a.san = c.san
                     WHERE c.id = i.holder_instance), 'something') || '.'
    ELSE 'Nobody has it.' END
$$;

CREATE FUNCTION thing_words(p_instance uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(a.name, i.san) FROM instance i LEFT JOIN asset a ON a.san = i.san
WHERE i.id = p_instance
$$;

-- What `take`, `drop` and `give` answer: where the thing is now.
CREATE FUNCTION held_view(p_instance uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, auth AS $$
SELECT jsonb_build_object('instance', i.id, 'name', thing_words(i.id), 'rev', i.rev,
    'lon', i.lon, 'lat', i.lat, 'h', i.h,
    'holder_player', i.holder_player, 'holder', player_name(i.holder_player),
    'holder_instance', i.holder_instance)
FROM instance i WHERE i.id = p_instance
$$;

-- Picking it up: off the ground, or out of a container on land the taker
-- builds on. A CAS on the holder — the second hand finds it gone.
CREATE FUNCTION take(p_instance uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    me  uuid := current_user_id();
    was instance%ROWTYPE;
BEGIN
    IF me IS NULL THEN
        RAISE EXCEPTION 'sign in first' USING errcode = '42501';
    END IF;
    SELECT * INTO was FROM instance WHERE id = p_instance AND deleted_at IS NULL;
    IF was.id IS NULL THEN
        RAISE EXCEPTION 'nothing of that name is anywhere' USING errcode = '23503';
    END IF;
    IF NOT was.carry THEN
        RAISE EXCEPTION '% cannot be picked up.', thing_words(p_instance) USING errcode = '22023';
    END IF;
    UPDATE instance i SET holder_player = me, holder_instance = NULL, lon = NULL, lat = NULL
    WHERE i.id = p_instance AND i.deleted_at IS NULL AND i.holder_player IS NULL
      AND (i.holder_instance IS NULL OR is_area_proposer(
          (SELECT c.area_id FROM instance c WHERE c.id = i.holder_instance)));
    IF NOT FOUND THEN
        SELECT * INTO was FROM instance WHERE id = p_instance;
        -- 409, not 40001: PostgREST retries a serialization failure until it
        -- goes through, and this one never will.
        RAISE EXCEPTION '%', holder_words(was) USING errcode = 'PT409';
    END IF;
    RETURN held_view(p_instance);
END
$$;

-- Putting it down where the holder stands: on their own land, on land they
-- build on, or back on the land it came from.
CREATE FUNCTION drop(p_instance uuid, p_lon double precision, p_lat double precision,
                     p_h double precision DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    me   uuid := current_user_id();
    was  instance%ROWTYPE;
    land uuid;
BEGIN
    SELECT * INTO was FROM instance WHERE id = p_instance AND deleted_at IS NULL;
    IF was.id IS NULL OR was.holder_player IS DISTINCT FROM me OR me IS NULL THEN
        RAISE EXCEPTION 'You are not holding that.' USING errcode = '42501';
    END IF;
    SELECT a.id INTO land FROM area a
    WHERE st_covers(a.geom, st_setsrid(st_makepoint(p_lon, p_lat), world_srid()))
      AND (a.id = was.area_id OR is_area_proposer(a.id))
    ORDER BY a.id = was.area_id DESC, a.created_at LIMIT 1;
    IF land IS NULL THEN
        RAISE EXCEPTION 'You can only put % down on land you build on, or where it came from.',
            thing_words(p_instance) USING errcode = '42501';
    END IF;
    UPDATE instance SET holder_player = NULL, lon = p_lon, lat = p_lat,
                        h = coalesce(p_h, 0), area_id = land
    WHERE id = p_instance AND holder_player = me;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'You are not holding that any more.' USING errcode = 'PT409';
    END IF;
    RETURN held_view(p_instance);
END
$$;

-- Handing it on: to a player, or into a container. Whoever holds it may give
-- it; a thing in a container is given out by whoever builds where the
-- container stands (a shop, a chest a flow opens).
CREATE FUNCTION give(p_instance uuid, p_to text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    me   uuid := current_user_id();
    was  instance%ROWTYPE;
    dest uuid;
    box  instance%ROWTYPE;
    hold jsonb;
BEGIN
    SELECT * INTO was FROM instance WHERE id = p_instance AND deleted_at IS NULL;
    IF me IS NULL OR was.id IS NULL OR NOT (was.holder_player IS NOT DISTINCT FROM me OR (
        was.holder_instance IS NOT NULL AND is_area_proposer(
            (SELECT c.area_id FROM instance c WHERE c.id = was.holder_instance)))) THEN
        RAISE EXCEPTION 'That is not yours to give.' USING errcode = '42501';
    END IF;
    BEGIN
        dest := p_to::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Give it to whom? "%" is nobody.', p_to USING errcode = '22023';
    END;
    IF EXISTS (SELECT 1 FROM auth.user u WHERE u.id = dest) THEN
        UPDATE instance SET holder_player = dest, holder_instance = NULL
        WHERE id = p_instance AND rev = was.rev;
    ELSE
        SELECT * INTO box FROM instance WHERE id = dest AND deleted_at IS NULL;
        SELECT a.parts -> 'hold' INTO hold FROM asset a WHERE a.san = box.san;
        IF hold IS NULL THEN
            RAISE EXCEPTION '% holds nothing.', coalesce(thing_words(dest), 'That')
                USING errcode = '22023';
        END IF;
        IF (SELECT count(*) FROM instance c WHERE c.holder_instance = dest)
           >= (hold ->> 'capacity')::int THEN
            RAISE EXCEPTION '% is full.', thing_words(dest) USING errcode = '23514';
        END IF;
        IF jsonb_array_length(coalesce(hold -> 'kinds', '[]')) > 0 AND NOT (hold -> 'kinds') ?
           (SELECT coalesce(a.parts #>> '{carry,kind}', 'thing') FROM asset a WHERE a.san = was.san) THEN
            RAISE EXCEPTION '% does not take %.', thing_words(dest), thing_words(p_instance)
                USING errcode = '23514';
        END IF;
        UPDATE instance SET holder_player = NULL, holder_instance = dest
        WHERE id = p_instance AND rev = was.rev;
    END IF;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Somebody else moved it first.' USING errcode = 'PT409';
    END IF;
    RETURN held_view(p_instance);
END
$$;

-- What I am carrying, for the Place panel.
CREATE FUNCTION my_holdings() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(held_view(i.id) ORDER BY i.rev), '[]'::jsonb)
FROM instance i WHERE i.holder_player = current_user_id() AND i.deleted_at IS NULL
$$;

GRANT EXECUTE ON FUNCTION holder_words(instance), thing_words(uuid), held_view(uuid),
    my_holdings() TO anon, player, admin, flow;
GRANT EXECUTE ON FUNCTION take(uuid), drop(uuid, double precision, double precision,
    double precision), give(uuid, text) TO player, admin, flow;

-- ---------------------------------------------------------------- the api

CREATE OR REPLACE VIEW api.instance WITH (security_invoker = true)
AS SELECT * FROM public.instance;

CREATE FUNCTION api.take(p_instance uuid) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.take(p_instance)$$;
CREATE FUNCTION api.drop(p_instance uuid, p_lon double precision, p_lat double precision,
                         p_h double precision DEFAULT 0) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.drop(p_instance, p_lon, p_lat, p_h)$$;
CREATE FUNCTION api.give(p_instance uuid, p_to text) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.give(p_instance, p_to)$$;
CREATE FUNCTION api.my_holdings() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.my_holdings()$$;

GRANT EXECUTE ON FUNCTION api.take(uuid), api.drop(uuid, double precision,
    double precision, double precision), api.give(uuid, text) TO player, admin, flow;
GRANT EXECUTE ON FUNCTION api.my_holdings() TO player, admin;
