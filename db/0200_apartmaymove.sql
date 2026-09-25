-- 0200_apartmaymove.sql — a part may move, and every tab sees it move alike.
--
-- TASKS-live.md LV.1. A crane's arm swings, a gate's bar lifts, a flag turns
-- on its pole. The maker marks the node as a `joint` and gives it one or more
-- of three ports:
--
--   pose  {to: {x,y,z,yaw,pitch,roll,scale}, over_s}   go there, taking so long
--   path  {route_m: [[x,y,z],…], speed, loop}          follow a line, m/s
--   spin  {axis, rpm}                                  turn for ever
--
-- Nothing is sent per frame. A write records the world clock (db/0168) and
-- where the part was at that second (`start`), worked out here from the row it
-- replaces; every tab then evaluates the same motion from the same row against
-- the same clock (client/lib/joint.js), so two tabs put the arm in the same
-- place at the same second without talking to each other.
--
-- Invariant 2: a part with a role is drawn over the splats and never baked.
-- assemble-v17 left only a screen's surface out; assemble-v18 leaves out every
-- role part, and dataset-v9 carries it. A port write dirties no tile.

-- ---------------------------------------------------------- the vocabulary

-- db/0160's check_marks, with `joint` among the roles.
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
END
$$;

-- The three kinds a moving part is told.
CREATE FUNCTION is_motion(p_type text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$SELECT p_type IN ('pose', 'path', 'spin')$$;

-- db/0160's check_ports, with the three motion kinds.
CREATE OR REPLACE FUNCTION check_ports(p_parts jsonb, p_names text []) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    m    jsonb;
    seen text [] := '{}';
BEGIN
    FOR m IN SELECT * FROM jsonb_array_elements(coalesce(p_parts -> 'ports', '[]')) LOOP
        IF NOT marks_token(m ->> 'name') THEN
            RAISE EXCEPTION '"%" is not a name a port may have', m ->> 'name';
        END IF;
        IF m ->> 'name' = ANY (seen) THEN
            RAISE EXCEPTION 'there are two ports called %', m ->> 'name';
        END IF;
        seen := seen || (m ->> 'name');
        IF (m ->> 'type') NOT IN ('boolean', 'number', 'text', 'image', 'colour',
                                  'pose', 'path', 'spin') THEN
            RAISE EXCEPTION '% is not a kind of port', m ->> 'name';
        END IF;
        IF (m #>> '{drives,part}') IS NULL OR (m #>> '{drives,part}') <> ALL (p_names) THEN
            RAISE EXCEPTION '% drives %, which is not a part',
                m ->> 'name', coalesce(m #>> '{drives,part}', 'nothing');
        END IF;
    END LOOP;
END
$$;

-- ---------------------------------------------------------------- the values

-- What a moving part is at rest: where the maker left it.
CREATE FUNCTION rest_pose() RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
SELECT '{"x": 0, "y": 0, "z": 0, "yaw": 0, "pitch": 0, "roll": 0, "scale": 1}'::jsonb
$$;

CREATE FUNCTION is_num(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$SELECT v IS NULL OR jsonb_typeof(v) = 'number'$$;

-- A pose: where to go, all of it optional, and how long to take.
CREATE FUNCTION check_pose(v jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    k text;
BEGIN
    IF jsonb_typeof(v -> 'to') IS DISTINCT FROM 'object' AND v -> 'to' IS NOT NULL THEN
        RAISE EXCEPTION 'a pose says where to go: {"to": {"yaw": 90}}' USING errcode = '22023';
    END IF;
    FOR k IN SELECT jsonb_object_keys(coalesce(v -> 'to', '{}')) LOOP
        IF k NOT IN ('x', 'y', 'z', 'yaw', 'pitch', 'roll', 'scale')
           OR jsonb_typeof(v -> 'to' -> k) <> 'number' THEN
            RAISE EXCEPTION 'a pose moves x, y, z, yaw, pitch, roll and scale, in numbers;'
                            ' not %', k USING errcode = '22023';
        END IF;
    END LOOP;
    IF (v #>> '{to,scale}')::numeric <= 0 THEN
        RAISE EXCEPTION 'a part cannot be made nothing: scale above 0' USING errcode = '22023';
    END IF;
    IF NOT is_num(v -> 'over_s') OR coalesce((v ->> 'over_s')::numeric, 0) NOT BETWEEN 0 AND 3600 THEN
        RAISE EXCEPTION 'a move takes between 0 and 3600 seconds' USING errcode = '22023';
    END IF;
END
$$;

-- A path: at least two points in the thing's own metres, and a speed.
CREATE FUNCTION check_path(v jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    p jsonb;
BEGIN
    IF jsonb_typeof(v -> 'route_m') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v -> 'route_m') < 2 THEN
        RAISE EXCEPTION 'a path is at least two points: [[x,y,z],[x,y,z]]'
            USING errcode = '22023';
    END IF;
    FOR p IN SELECT * FROM jsonb_array_elements(v -> 'route_m') LOOP
        IF jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) <> 3
           OR NOT (is_num(p -> 0) AND is_num(p -> 1) AND is_num(p -> 2)) THEN
            RAISE EXCEPTION 'a point on a path is three numbers, [x,y,z]' USING errcode = '22023';
        END IF;
    END LOOP;
    IF jsonb_typeof(v -> 'speed') IS DISTINCT FROM 'number'
       OR (v ->> 'speed')::numeric NOT BETWEEN 0.01 AND 100 THEN
        RAISE EXCEPTION 'a path is followed at between 0.01 and 100 m/s' USING errcode = '22023';
    END IF;
    IF v -> 'loop' IS NOT NULL AND jsonb_typeof(v -> 'loop') <> 'boolean' THEN
        RAISE EXCEPTION 'a path loops or it does not: true or false' USING errcode = '22023';
    END IF;
END
$$;

CREATE FUNCTION check_spin(v jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF coalesce(v ->> 'axis', 'y') NOT IN ('x', 'y', 'z') THEN
        RAISE EXCEPTION 'a part spins about x, y or z' USING errcode = '22023';
    END IF;
    IF jsonb_typeof(v -> 'rpm') IS DISTINCT FROM 'number'
       OR abs((v ->> 'rpm')::numeric) > 600 THEN
        RAISE EXCEPTION 'a spin is a number of turns a minute, at most 600'
            USING errcode = '22023';
    END IF;
END
$$;

-- db/0169's check_port_value, with the three motion kinds.
CREATE OR REPLACE FUNCTION check_port_value(p_type text, p_value jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    said text := jsonb_typeof(p_value);
BEGIN
    IF is_motion(p_type) AND said <> 'object' THEN
        RAISE EXCEPTION 'that port is told a %, as {…}, not %', p_type, said
            USING errcode = '22023';
    ELSIF p_type = 'pose' THEN PERFORM check_pose(p_value);
    ELSIF p_type = 'path' THEN PERFORM check_path(p_value);
    ELSIF p_type = 'spin' THEN PERFORM check_spin(p_value);
    ELSIF p_type = 'boolean' AND said <> 'boolean' THEN
        RAISE EXCEPTION 'that port is on or off, not %', said USING errcode = '22023';
    ELSIF p_type = 'number' AND said <> 'number' THEN
        RAISE EXCEPTION 'that port is a number, not %', said USING errcode = '22023';
    ELSIF p_type IN ('text', 'image', 'colour') AND said <> 'string' THEN
        RAISE EXCEPTION 'that port is written in words, not %', said
            USING errcode = '22023';
    ELSIF p_type = 'colour' AND (p_value #>> '{}') !~ '^#[0-9a-fA-F]{6}$' THEN
        RAISE EXCEPTION '"%" is not a colour — write it as #rrggbb', p_value #>> '{}'
            USING errcode = '22023';
    ELSIF p_type = 'image' AND (p_value #>> '{}') !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'a screen shows a picture the world holds, named by its'
                        ' sha256' USING errcode = '22023';
    END IF;
END
$$;

-- db/0198's port_value_of: a flow says everything in words, and a motion is
-- a JSON object said as words. Words that are not JSON are left as they are,
-- for check_port_value to refuse in its own sentence.
CREATE OR REPLACE FUNCTION port_value_of(p_type text, p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF jsonb_typeof(p_value) <> 'string' THEN
        RETURN p_value;
    ELSIF is_motion(p_type) AND (p_value #>> '{}') ~ '^\s*\{' THEN
        BEGIN
            RETURN (p_value #>> '{}')::jsonb;
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN p_value;
        END;
    ELSIF p_type = 'boolean' AND p_value #>> '{}' IN ('true', 'false') THEN
        RETURN to_jsonb((p_value #>> '{}')::boolean);
    ELSIF p_type = 'number' AND p_value #>> '{}' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
        RETURN to_jsonb((p_value #>> '{}')::numeric);
    END IF;
    RETURN p_value;
END
$$;
