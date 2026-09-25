-- 0201_apartmovesbytheclock.sql — where a moving part is, by the world clock.
--
-- TASKS-live.md LV.1, continued from db/0200 (the vocabulary and the values).
-- A write records the world clock and where the part was then; the read
-- hands both back, and every tab evaluates the motion from them
-- (client/lib/joint.js).

-- ------------------------------------------------------------- the motion

ALTER TABLE live_state
ADD COLUMN clock double precision,
ADD COLUMN start jsonb;

COMMENT ON COLUMN live_state.clock IS
    'world_clock() when this was written; a motion is evaluated from it';
COMMENT ON COLUMN live_state.start IS
    'where the part was at `clock`, for a pose or a spin (LV.1)';

CREATE FUNCTION pose_num(p jsonb, k text) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $$
SELECT coalesce((p ->> k)::double precision, (rest_pose() ->> k)::double precision)
$$;

-- A pose in motion: from `start` towards `to`, in a straight line, arriving
-- `over_s` after `clock`. client/lib/joint.js says the same.
CREATE FUNCTION pose_at(p_value jsonb, p_start jsonb, p_clock double precision,
                        p_t double precision) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
WITH f AS (
    SELECT CASE WHEN coalesce((p_value ->> 'over_s')::double precision, 0) <= 0 THEN 1
        ELSE least(1, greatest(0, (p_t - p_clock)
            / (p_value ->> 'over_s')::double precision)) END AS f
)
SELECT jsonb_object_agg(k, pose_num(p_start, k)
    + (coalesce((p_value -> 'to' ->> k)::double precision, pose_num(p_start, k))
       - pose_num(p_start, k)) * f.f)
FROM f, unnest(ARRAY['x', 'y', 'z', 'yaw', 'pitch', 'roll', 'scale']) k
$$;

-- A spin: the start's angle about the axis, plus rpm turns a minute since.
CREATE FUNCTION spin_at(p_value jsonb, p_start jsonb, p_clock double precision,
                        p_t double precision) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
SELECT rest_pose() || coalesce(p_start, '{}') || jsonb_build_object(k,
    mod((pose_num(p_start, k) + (p_value ->> 'rpm')::double precision * 6
         * (p_t - p_clock))::numeric, 360)::double precision)
FROM (SELECT CASE coalesce(p_value ->> 'axis', 'y')
    WHEN 'x' THEN 'pitch' WHEN 'z' THEN 'roll' ELSE 'yaw' END AS k) a
$$;

-- A path: so many metres along the line, facing the way it goes. Round again
-- when it loops, stopped at the end when it does not.
CREATE FUNCTION path_at(p_value jsonb, p_clock double precision,
                        p_t double precision) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    pts   jsonb := p_value -> 'route_m';
    n     int := jsonb_array_length(pts);
    total double precision := 0;
    d     double precision;
    seg   double precision;
    a     double precision [];
    b     double precision [];
BEGIN
    FOR i IN 0 .. n - 2 LOOP
        total := total + path_leg(pts -> i, pts -> (i + 1));
    END LOOP;
    d := greatest(0, (p_value ->> 'speed')::double precision * (p_t - p_clock));
    d := CASE WHEN total <= 0 THEN 0
        WHEN coalesce((p_value ->> 'loop')::boolean, false) THEN d - total * floor(d / total)
        ELSE least(d, total) END;
    FOR i IN 0 .. n - 2 LOOP
        seg := path_leg(pts -> i, pts -> (i + 1));
        IF d <= seg OR i = n - 2 THEN
            a := ARRAY[(pts -> i ->> 0)::float8, (pts -> i ->> 1)::float8, (pts -> i ->> 2)::float8];
            b := ARRAY[(pts -> (i + 1) ->> 0)::float8, (pts -> (i + 1) ->> 1)::float8,
                       (pts -> (i + 1) ->> 2)::float8];
            d := CASE WHEN seg > 0 THEN least(1, d / seg) ELSE 0 END;
            RETURN rest_pose() || jsonb_build_object(
                'x', a[1] + (b[1] - a[1]) * d, 'y', a[2] + (b[2] - a[2]) * d,
                'z', a[3] + (b[3] - a[3]) * d,
                'yaw', degrees(atan2(-(b[1] - a[1]), -(b[3] - a[3]))));
        END IF;
        d := d - seg;
    END LOOP;
    RETURN rest_pose();
END
$$;

CREATE FUNCTION path_leg(a jsonb, b jsonb) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $$
SELECT sqrt(power((b ->> 0)::float8 - (a ->> 0)::float8, 2)
    + power((b ->> 1)::float8 - (a ->> 1)::float8, 2)
    + power((b ->> 2)::float8 - (a ->> 2)::float8, 2))
$$;

-- Where a part driven by this row is at `t`, whichever of the three it is.
CREATE FUNCTION motion_at(p_type text, p_value jsonb, p_start jsonb,
                          p_clock double precision, p_t double precision)
RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE p_type
    WHEN 'pose' THEN pose_at(p_value, p_start, p_clock, p_t)
    WHEN 'spin' THEN spin_at(p_value, p_start, p_clock, p_t)
    WHEN 'path' THEN path_at(p_value, p_clock, p_t)
    ELSE rest_pose() END
$$;

-- Where one part of one thing is now: the latest motion any of its ports was
-- told, evaluated at `t`. Nothing told yet, where the maker left it.
CREATE FUNCTION part_now(p_instance uuid, p_san text, p_part text,
                         p_t double precision) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce((
    SELECT motion_at(m ->> 'type', l.value, l.start, l.clock, p_t)
    FROM live_state l
    JOIN asset a ON a.san = p_san
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(a.parts -> 'ports', '[]')) m
    WHERE l.instance_id = p_instance AND m ->> 'name' = l.port
      AND m #>> '{drives,part}' = p_part AND is_motion(m ->> 'type')
      AND l.clock IS NOT NULL
    ORDER BY l.clock DESC, l.rev DESC LIMIT 1), rest_pose())
$$;

GRANT EXECUTE ON FUNCTION is_motion(text), rest_pose(), is_num(jsonb),
    check_pose(jsonb), check_path(jsonb), check_spin(jsonb),
    pose_num(jsonb, text), path_leg(jsonb, jsonb),
    pose_at(jsonb, jsonb, double precision, double precision),
    spin_at(jsonb, jsonb, double precision, double precision),
    path_at(jsonb, double precision, double precision),
    motion_at(text, jsonb, jsonb, double precision, double precision),
    part_now(uuid, text, text, double precision)
TO anon, player, admin, flow;

-- ---------------------------------------------------------------- the write

-- The row itself, once port_write has decided it may be written. Split out so
-- port_write stays one screen; nothing else calls it.
CREATE FUNCTION live_put(p_instance uuid, p_port text, p_value jsonb, p_held boolean,
                         p_default jsonb, p_clock double precision, p_start jsonb,
                         p_mine uuid) RETURNS live_state
LANGUAGE sql SET search_path = public AS $$
INSERT INTO live_state AS l (instance_id, port, value, pending, pending_by,
                             written_by, clock, start)
VALUES (p_instance, p_port,
        CASE WHEN p_held THEN coalesce(p_default, '""'::jsonb) ELSE p_value END,
        CASE WHEN p_held THEN p_value END,
        CASE WHEN p_held THEN p_mine END,
        p_mine, p_clock, p_start)
ON CONFLICT (instance_id, port) DO UPDATE
SET value      = CASE WHEN p_held THEN l.value ELSE excluded.value END,
    pending    = excluded.pending,
    pending_by = excluded.pending_by,
    rev        = nextval('live_rev'),
    written_by = p_mine,
    at         = now(),
    clock      = excluded.clock,
    start      = excluded.start
RETURNING *
$$;

-- db/0198's port_write, with the world clock and, for a motion, where the
-- part was when it was told.
CREATE OR REPLACE FUNCTION port_write(p_instance uuid, p_port text, p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    inst  instance%rowtype;
    decl  jsonb;
    mine  uuid := current_user_id();
    clk   double precision := world_clock();
    out   live_state%rowtype;
BEGIN
    IF mine IS NULL THEN
        RAISE EXCEPTION 'sign in first' USING errcode = '42501';
    END IF;
    SELECT * INTO inst FROM instance WHERE id = p_instance AND deleted_at IS null;
    IF inst.id IS NULL THEN
        RAISE EXCEPTION 'nothing of that name is standing anywhere' USING errcode = '23503';
    END IF;
    IF NOT may_write_port(p_instance) THEN
        RAISE EXCEPTION 'that is not your land' USING errcode = '42501';
    END IF;
    decl := port_of(inst.san, p_port);
    IF decl IS NULL THEN
        RAISE EXCEPTION '% cannot be told "%"', inst.san, p_port USING errcode = '22023';
    END IF;
    p_value := port_value_of(decl ->> 'type', p_value);
    PERFORM check_port_value(decl ->> 'type', p_value);
    IF (decl ->> 'type') = 'image'
       AND NOT EXISTS (SELECT 1 FROM artifact
                       WHERE sha256 = p_value #>> '{}' AND kind = 'material') THEN
        RAISE EXCEPTION 'the world has no picture with that sha256' USING errcode = '23503';
    END IF;
    -- D13: a screen waits for the land's approver (db/0169).
    out := live_put(p_instance, p_port, p_value, (decl ->> 'type') = 'image',
        to_jsonb(decl ->> 'default'), clk,
        CASE WHEN is_motion(decl ->> 'type')
             THEN part_now(p_instance, inst.san, decl #>> '{drives,part}', clk) END,
        mine);
    RETURN jsonb_build_object('instance', out.instance_id, 'port', out.port,
                              'value', out.value, 'pending', out.pending,
                              'rev', out.rev, 'clock', out.clock, 'start', out.start,
                              'waiting', out.pending IS NOT NULL);
END
$$;

-- ----------------------------------------------------------------- the read

-- db/0169's live_near, with the clock and the start every tab evaluates from.
CREATE OR REPLACE FUNCTION live_near(p_lon double precision, p_lat double precision,
                                     p_metres double precision DEFAULT 500,
                                     p_since bigint DEFAULT 0)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'instance', l.instance_id, 'port', l.port, 'value', l.value,
    'rev', l.rev, 'clock', l.clock, 'start', l.start) ORDER BY l.rev), '[]'::jsonb)
FROM live_state l
JOIN instance i ON i.id = l.instance_id AND i.deleted_at IS null
WHERE l.rev > p_since
  AND st_dwithin(i.geom::geography,
                 st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography,
                 p_metres);
$$;

CREATE OR REPLACE FUNCTION live_of(p_instance uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_object_agg(l.port, jsonb_build_object(
    'value', l.value, 'rev', l.rev, 'clock', l.clock, 'start', l.start,
    'pending', CASE WHEN public.may_write_port(p_instance) THEN l.pending END)),
    '{}'::jsonb)
FROM live_state l WHERE l.instance_id = p_instance;
$$;

-- The api view was made with *, when the table had neither column.
CREATE OR REPLACE VIEW api.live_state WITH (security_invoker = true)
AS SELECT * FROM public.live_state;
