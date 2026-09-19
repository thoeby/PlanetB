-- 0169_thingscanbeonoroff.sql — a placed thing can be told things, and the
-- world remembers what it was told.
--
-- TASKS-foundation.md FND.15. A lamp's head lights up when its `on` port is
-- set; a billboard's screen shows whatever its `image` port names. None of
-- that is baked into a tile — the splats are the world as it was compiled, and
-- a switch nobody has to recompile is the whole point — so what a port is set
-- to lives here, beside the instance, and the page draws it over the splats
-- (client/js/live.js).
--
-- Which ports a thing has, and what each may be set to, is the product's
-- (FND.6, db/0160 `check_ports`): boolean, number, text, image or colour. This
-- file holds nobody to a value the product did not declare (Invariant 6: the
-- page may ask, the database decides).
--
-- One port is not like the others. An `image` is an advertisement — somebody
-- else's land, somebody else's eyes — so it is written as a *pending* value
-- and everybody goes on seeing the old one until the land's approver says yes
-- (D13, db/0170). Approving it compiles nothing: nothing baked changed.

-- A rev that counts across the whole table, not per row: the page asks "what
-- has changed since the number I last saw", and a per-row counter cannot
-- answer that.
CREATE SEQUENCE live_rev;

CREATE TABLE live_state (
    instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
    port        text NOT NULL,
    value       jsonb NOT NULL,
    -- An image waiting for the land's approver. Null once it is theirs.
    pending     jsonb,
    pending_by  uuid REFERENCES auth.user (id),
    rev         bigint NOT NULL DEFAULT nextval('live_rev'),
    written_by  uuid NOT NULL REFERENCES auth.user (id),
    at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (instance_id, port)
);

CREATE INDEX live_state_rev_idx ON live_state (rev);

ALTER TABLE live_state ENABLE ROW LEVEL SECURITY;

-- What a thing is set to is the world's, the same way where it stands is: a
-- player walking past sees the lamp lit whoever lit it.
CREATE POLICY readable ON live_state FOR SELECT TO anon, player, admin USING (true);
GRANT SELECT ON live_state TO anon, player, admin;

-- Invariant 6: nothing writes this table but `port_write`, which asks the
-- policies first. No INSERT/UPDATE grant is given to anybody.

-- ------------------------------------------------------------ the vocabulary

-- The port a product declares under that name, or null.
CREATE FUNCTION port_of(p_san text, p_port text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT m FROM asset a,
     jsonb_array_elements(coalesce(a.parts -> 'ports', '[]'::jsonb)) m
WHERE a.san = p_san AND m ->> 'name' = p_port;
$$;

GRANT EXECUTE ON FUNCTION port_of(text, text) TO anon, player, admin;

-- What may be written to a port of that kind. db/0160 already holds makers to
-- the five kinds there are; this holds writers to what each kind means.
CREATE FUNCTION check_port_value(p_type text, p_value jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    said text := jsonb_typeof(p_value);
BEGIN
    IF p_type = 'boolean' AND said <> 'boolean' THEN
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

GRANT EXECUTE ON FUNCTION check_port_value(text, jsonb) TO anon, player, admin;

-- Who may set a port: whoever may build on the land it stands on. Not the
-- person who put it there — nobody records that (PLAYER-RUN.md) — and not
-- everybody, or a lamp is a thing passers-by switch.
CREATE FUNCTION may_write_port(p_instance uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT EXISTS (SELECT 1 FROM instance i
               WHERE i.id = p_instance AND i.deleted_at IS null
                 AND public.is_area_proposer(i.area_id));
$$;

GRANT EXECUTE ON FUNCTION may_write_port(uuid) TO anon, player, admin;

-- ---------------------------------------------------------------- the write

-- Setting one port of one placed thing. FND.14 left this refusing everybody
-- with "flows do not run yet"; it now answers a player, and goes on refusing a
-- flow, which has no login of its own until F10.
CREATE OR REPLACE FUNCTION port_write(p_instance uuid, p_port text, p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    inst  instance%rowtype;
    decl  jsonb;
    mine  uuid := current_user_id();
    held  boolean;
    out   live_state%rowtype;
BEGIN
    IF mine IS NULL THEN
        RAISE EXCEPTION 'sign in first' USING errcode = '42501';
    END IF;
    SELECT * INTO inst FROM instance
    WHERE id = p_instance AND deleted_at IS null;
    IF inst.id IS NULL THEN
        RAISE EXCEPTION 'nothing of that name is standing anywhere'
            USING errcode = '23503';
    END IF;
    IF NOT may_write_port(p_instance) THEN
        RAISE EXCEPTION 'that is not your land' USING errcode = '42501';
    END IF;
    decl := port_of(inst.san, p_port);
    IF decl IS NULL THEN
        RAISE EXCEPTION '% cannot be told "%"', inst.san, p_port
            USING errcode = '22023';
    END IF;
    PERFORM check_port_value(decl ->> 'type', p_value);
    -- A picture the world already holds, registered as one: a screen is not a
    -- way to point at bytes nobody put in the store (Invariant 1).
    IF (decl ->> 'type') = 'image'
       AND NOT EXISTS (SELECT 1 FROM artifact
                       WHERE sha256 = p_value #>> '{}' AND kind = 'material') THEN
        RAISE EXCEPTION 'the world has no picture with that sha256'
            USING errcode = '23503';
    END IF;

    -- D13: a screen is an advertisement, so the land's approver sees it first
    -- and everybody else goes on seeing what is there.
    held := (decl ->> 'type') = 'image';

    INSERT INTO live_state AS l (instance_id, port, value, pending, pending_by,
                                 written_by)
    VALUES (p_instance, p_port,
            CASE WHEN held THEN coalesce(to_jsonb(decl ->> 'default'), '""'::jsonb)
                 ELSE p_value END,
            CASE WHEN held THEN p_value END,
            CASE WHEN held THEN mine END,
            mine)
    ON CONFLICT (instance_id, port) DO UPDATE
    SET value      = CASE WHEN held THEN l.value ELSE excluded.value END,
        pending    = excluded.pending,
        pending_by = excluded.pending_by,
        rev        = nextval('live_rev'),
        written_by = mine,
        at         = now()
    RETURNING * INTO out;

    RETURN jsonb_build_object('instance', out.instance_id, 'port', out.port,
                              'value', out.value, 'pending', out.pending,
                              'rev', out.rev,
                              'waiting', out.pending IS NOT NULL);
END
$$;

GRANT EXECUTE ON FUNCTION port_write(uuid, text, jsonb) TO player, admin;

-- ----------------------------------------------------------------- the read

-- Everything live within reach of where somebody is standing, changed since
-- the number they last saw. A degree of latitude is 111 km; the box is square
-- in metres, which is close enough for a thing you can see.
CREATE FUNCTION live_near(p_lon double precision, p_lat double precision,
                          p_metres double precision DEFAULT 500,
                          p_since bigint DEFAULT 0)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'instance', l.instance_id, 'port', l.port, 'value', l.value,
    'rev', l.rev) ORDER BY l.rev), '[]'::jsonb)
FROM live_state l
JOIN instance i ON i.id = l.instance_id AND i.deleted_at IS null
WHERE l.rev > p_since
  AND st_dwithin(i.geom::geography,
                 st_setsrid(st_makepoint(p_lon, p_lat), world_srid())::geography,
                 p_metres);
$$;

GRANT EXECUTE ON FUNCTION live_near(double precision, double precision,
                                    double precision, bigint)
TO anon, player, admin;

-- What one thing is set to, and what is waiting on it — the Ports section of
-- the Place panel. The pending value is shown to whoever may write the port;
-- to everybody else a screen is simply what it is showing.
CREATE FUNCTION live_of(p_instance uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_object_agg(l.port, jsonb_build_object(
    'value', l.value, 'rev', l.rev,
    'pending', CASE WHEN public.may_write_port(p_instance) THEN l.pending END)),
    '{}'::jsonb)
FROM live_state l WHERE l.instance_id = p_instance;
$$;

GRANT EXECUTE ON FUNCTION live_of(uuid) TO anon, player, admin;

CREATE VIEW api.live_state WITH (security_invoker = true)
AS SELECT * FROM public.live_state;
GRANT SELECT ON api.live_state TO anon, player, admin;

CREATE OR REPLACE FUNCTION api.port_write(p_instance uuid, p_port text, p_value jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE
AS $$SELECT public.port_write(p_instance, p_port, p_value)$$;
CREATE FUNCTION api.live_near(p_lon double precision, p_lat double precision,
                              p_metres double precision DEFAULT 500,
                              p_since bigint DEFAULT 0) RETURNS jsonb
LANGUAGE sql STABLE
AS $$SELECT public.live_near(p_lon, p_lat, p_metres, p_since)$$;
CREATE FUNCTION api.live_of(p_instance uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.live_of(p_instance)$$;

GRANT EXECUTE ON FUNCTION api.port_write(uuid, text, jsonb) TO player, admin;
GRANT EXECUTE ON FUNCTION api.live_near(double precision, double precision,
                                        double precision, bigint),
    api.live_of(uuid) TO anon, player, admin;
