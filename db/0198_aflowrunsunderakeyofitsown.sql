-- 0198_aflowrunsunderakeyofitsown.sql — a flow sent to a process server, and
-- the key it writes to the world with.
--
-- TASKS-flows.md FL.7, which approves the table, the role and the two RPCs.
-- A player runs a flow on a process server of their own: the page sends the
-- ELX and makes the job there (the world sends nothing out, Invariant 9), and
-- the world issues the job a key — a JWT for the role `flow` that names the
-- flow, its land and a key id. The process server writes through PostgREST
-- with it like any other caller, under the same functions and policies
-- (Invariant 6); what the key may do is decided here, per call:
--
--   * only the writes granted to `flow` (port_write, and the clock);
--   * only to things on that flow's own land;
--   * only while the key is not withdrawn and the flow still exists;
--   * only while whoever issued it may still build on that land.
--
-- The key is returned once and never stored; the world keeps its id (jti).
-- A write made with it is recorded as written by the player who issued it —
-- live_state.written_by is a user, and this migration does not change it.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flow') THEN
        CREATE ROLE flow NOLOGIN;
    END IF;
END
$$;
GRANT flow TO authenticator;
GRANT USAGE ON SCHEMA api TO flow;

CREATE TABLE flow_deployment (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    flow_id           uuid NOT NULL REFERENCES flow (id) ON DELETE CASCADE,
    server_id         uuid NOT NULL REFERENCES process_server (id),
    elx_sha256        text NOT NULL REFERENCES artifact (sha256),
    remote_process_id text NOT NULL,
    remote_job_id     text NOT NULL,
    key_jti           uuid NOT NULL UNIQUE,
    created_by        uuid NOT NULL REFERENCES auth.user (id),
    created_at        timestamptz NOT NULL DEFAULT now(),
    revoked_at        timestamptz
);
CREATE UNIQUE INDEX flow_deployment_live_idx ON flow_deployment (flow_id, server_id)
WHERE revoked_at IS NULL;

-- Read as the flow is read (db/0155): whoever builds on or approves for the
-- land sees where its flows run.
ALTER TABLE flow_deployment ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_rights ON flow_deployment FOR SELECT
USING (EXISTS (SELECT 1 FROM flow f WHERE f.id = flow_id
               AND (is_area_proposer(f.area_id) OR is_area_approver(f.area_id))));
GRANT SELECT ON flow_deployment TO player, admin;

-- The claims of the key the caller came with, when it is a flow's.
CREATE FUNCTION flow_claim(p_name text) RETURNS text
LANGUAGE sql STABLE AS $$
SELECT nullif(current_setting('request.jwt.claims', true), '')::json ->> p_name;
$$;
GRANT EXECUTE ON FUNCTION flow_claim(text) TO flow, player, admin;

-- Whether the flow key the caller holds reaches a thing on this land now.
CREATE FUNCTION flow_key_reaches(p_area uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT current_user_role() = 'flow' AND EXISTS (
    SELECT 1 FROM flow_deployment d JOIN flow f ON f.id = d.flow_id
    WHERE d.key_jti::text = flow_claim('jti')
      AND f.id::text = flow_claim('flow')
      AND d.revoked_at IS NULL AND f.deleted_at IS NULL
      AND f.area_id = p_area
      AND is_area_proposer(p_area));
$$;
GRANT EXECUTE ON FUNCTION flow_key_reaches(uuid) TO flow, player, admin;

-- A World block writes what the ELX carries, which is words: Write Port's
-- composite (client/flow/world/assets/nodes/port__write.xml) puts its Value
-- into the request as a JSON string. "true" to a switch and "12" to a number
-- are read as what they say; anything else is left for check_port_value to
-- refuse in its own words. db/0169's port_write, with that one line added.
CREATE FUNCTION port_value_of(p_type text, p_value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE
    WHEN jsonb_typeof(p_value) <> 'string' THEN p_value
    WHEN p_type = 'boolean' AND p_value #>> '{}' IN ('true', 'false')
        THEN to_jsonb((p_value #>> '{}')::boolean)
    WHEN p_type = 'number' AND p_value #>> '{}' ~ '^-?[0-9]+(\.[0-9]+)?$'
        THEN to_jsonb((p_value #>> '{}')::numeric)
    ELSE p_value END;
$$;
GRANT EXECUTE ON FUNCTION port_value_of(text, jsonb) TO anon, player, admin, flow;

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
    -- A flow says everything in words (0198, port_value_of).
    p_value := port_value_of(decl ->> 'type', p_value);
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


-- db/0169's rule, with the flow's own beside it. Same signature, so
-- port_write asks it as before.
CREATE OR REPLACE FUNCTION may_write_port(p_instance uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT EXISTS (SELECT 1 FROM instance i
               WHERE i.id = p_instance AND i.deleted_at IS null
                 AND CASE WHEN current_user_role() = 'flow'
                          THEN public.flow_key_reaches(i.area_id)
                          ELSE public.is_area_proposer(i.area_id) END);
$$;
GRANT EXECUTE ON FUNCTION may_write_port(uuid) TO flow;
GRANT EXECUTE ON FUNCTION port_write(uuid, text, jsonb) TO flow;
GRANT EXECUTE ON FUNCTION api.port_write(uuid, text, jsonb) TO flow;
GRANT EXECUTE ON FUNCTION world_clock() TO flow;
GRANT EXECUTE ON FUNCTION api.world_clock() TO flow;
GRANT EXECUTE ON FUNCTION current_user_id() TO flow;
GRANT EXECUTE ON FUNCTION current_user_role() TO flow;

-- Run on <server>: the process and the job exist on the server already (the
-- page made them); this records where the flow runs and issues the job its
-- key. A flow already running there is stopped first: one live key per flow
-- and server.
CREATE FUNCTION deploy_flow(p_flow uuid, p_server uuid, p_elx_sha256 text,
                            p_process text, p_job text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    f   flow%ROWTYPE;
    jti uuid := gen_random_uuid();
    dep uuid;
BEGIN
    SELECT * INTO f FROM flow WHERE id = p_flow AND deleted_at IS NULL;
    IF f.id IS NULL OR NOT is_area_proposer(f.area_id) THEN
        RAISE EXCEPTION 'You may not run flows on %.', coalesce((SELECT nullif(
            a.rules ->> 'name', '') FROM area a WHERE a.id = f.area_id), 'that land')
            USING errcode = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM process_server s WHERE s.id = p_server
                   AND s.owner_id = current_user_id() AND s.deleted_at IS NULL) THEN
        RAISE EXCEPTION 'That is not one of your servers.' USING errcode = '42501';
    END IF;
    UPDATE flow_deployment SET revoked_at = now()
    WHERE flow_id = p_flow AND server_id = p_server AND revoked_at IS NULL;
    INSERT INTO flow_deployment (flow_id, server_id, elx_sha256, remote_process_id,
                                 remote_job_id, key_jti, created_by)
    VALUES (p_flow, p_server, p_elx_sha256, p_process, p_job, jti, current_user_id())
    RETURNING id INTO dep;
    RETURN jsonb_build_object('id', dep, 'key', auth.sign(json_build_object(
        'role', 'flow', 'sub', current_user_id(), 'flow', p_flow,
        'area', f.area_id, 'jti', jti,
        'exp', extract(epoch FROM now() + interval '30 days')::bigint)));
END
$$;
GRANT EXECUTE ON FUNCTION deploy_flow(uuid, uuid, text, text, text) TO player, admin;

-- Stop: the key is withdrawn at once; the process stays on the server.
CREATE FUNCTION revoke_flow_key(p_deployment uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE flow_deployment d SET revoked_at = now()
    FROM flow f
    WHERE d.id = p_deployment AND f.id = d.flow_id AND d.revoked_at IS NULL
      AND is_area_proposer(f.area_id);
    RETURN FOUND;
END
$$;
GRANT EXECUTE ON FUNCTION revoke_flow_key(uuid) TO player, admin;

-- ---------------------------------------------------------------- the api

CREATE VIEW api.flow_deployment WITH (security_invoker = true) AS
SELECT
    id, flow_id, server_id, elx_sha256, remote_process_id, remote_job_id,
    created_by, created_at, revoked_at
FROM public.flow_deployment;
GRANT SELECT ON api.flow_deployment TO player, admin;

CREATE FUNCTION api.deploy_flow(flow uuid, server uuid, elx_sha256 text,
                                process text, job text) RETURNS jsonb
LANGUAGE sql VOLATILE
AS $$SELECT public.deploy_flow(flow, server, elx_sha256, process, job)$$;
GRANT EXECUTE ON FUNCTION api.deploy_flow(uuid, uuid, text, text, text) TO player, admin;

CREATE FUNCTION api.revoke_flow_key(deployment uuid) RETURNS boolean
LANGUAGE sql VOLATILE AS $$SELECT public.revoke_flow_key(deployment)$$;
GRANT EXECUTE ON FUNCTION api.revoke_flow_key(uuid) TO player, admin;
