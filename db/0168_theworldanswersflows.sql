-- 0168_theworldanswersflows.sql — the four things a flow may ask the world.
--
-- TASKS-foundation.md FND.14. A flow drawn in Automate is a file until
-- somebody runs it, and nobody runs one yet (F10). But a World block in a flow
-- names an address, and a flow is only worth validating against a world that
-- has those addresses: a block wired to `port_write` should be a block that
-- would work, not one that would 404 the first time a runner tried it.
--
-- So the four exist here, now, with the shape they will keep:
--
--   port_write(p_instance, p_port, p_value)   FND.15
--   mover_set(p_mover, p_fields)              FND.16
--   world_events(p_after)                     FND.15
--   world_clock()                             here
--
-- Three of them refuse every caller in one sentence, because a flow that runs
-- is F10's and saying so is better than half of it. `world_clock` answers:
-- everything that moves by the clock moves by this one, and there is nothing
-- to withhold about what the time is.

CREATE FUNCTION flows_do_not_run_yet() RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    RAISE EXCEPTION 'flows do not run yet' USING errcode = 'PT501';
END
$$;
GRANT EXECUTE ON FUNCTION flows_do_not_run_yet() TO anon, player, admin;

CREATE FUNCTION port_write(p_instance uuid, p_port text, p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM flows_do_not_run_yet();
    RETURN null;
END
$$;
GRANT EXECUTE ON FUNCTION port_write(uuid, text, jsonb) TO player, admin;

CREATE FUNCTION mover_set(p_mover uuid, p_fields jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM flows_do_not_run_yet();
    RETURN null;
END
$$;
GRANT EXECUTE ON FUNCTION mover_set(uuid, jsonb) TO player, admin;

CREATE FUNCTION world_events(p_after bigint DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM flows_do_not_run_yet();
    RETURN null;
END
$$;
GRANT EXECUTE ON FUNCTION world_events(bigint) TO player, admin;

-- The world's own clock, in seconds. One number, the same for everybody, so
-- two players standing at the same stop see the same bus at the same second
-- (FND.16). It decides nothing and reads nothing about anybody.
CREATE FUNCTION world_clock() RETURNS double precision
LANGUAGE sql STABLE AS $$SELECT extract(epoch FROM now())::double precision$$;
GRANT EXECUTE ON FUNCTION world_clock() TO anon, player, admin;

CREATE FUNCTION api.port_write(p_instance uuid, p_port text, p_value jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.port_write(p_instance, p_port, p_value)$$;
CREATE FUNCTION api.mover_set(p_mover uuid, p_fields jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.mover_set(p_mover, p_fields)$$;
CREATE FUNCTION api.world_events(p_after bigint DEFAULT 0) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.world_events(p_after)$$;
CREATE FUNCTION api.world_clock() RETURNS double precision
LANGUAGE sql STABLE AS $$SELECT public.world_clock()$$;
GRANT EXECUTE ON FUNCTION api.port_write(uuid, text, jsonb),
    api.mover_set(uuid, jsonb), api.world_events(bigint) TO player, admin;
GRANT EXECUTE ON FUNCTION api.world_clock() TO anon, player, admin;
