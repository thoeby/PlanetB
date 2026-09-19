-- 0133_flowsarefilesontheland.sql — a flow belongs to a land, and its ELX is a
-- file like every other file.
--
-- SPEC §2.16: the Automate view draws the logic a land runs, and a process
-- server somewhere else runs it. Nothing about that is computed here. What the
-- world holds is a pointer: which land, what the flow is called, and the
-- sha256 of the ELX the player's tab serialised and PUT into the file store
-- (Invariant 1 — the ELX is immutable and content-addressed, and a change
-- writes a new file rather than overwriting one).
--
-- Layout — where the boxes sit, which outputs are folded away, how the named
-- nets are drawn — is not part of the flow. The process server neither reads
-- nor writes it, and putting it in the ELX would make two identical flows two
-- different files. It lives in `flow.layout` beside the pointer.

-- A plugin description is a file in the store like everything else, and it is
-- not a flow: db/0127 named the four kinds this work stores, and this is the
-- fifth. Widened here rather than in a migration of its own because it is what
-- elx_plugin below points at.
ALTER TABLE artifact DROP CONSTRAINT artifact_kind_check;
ALTER TABLE artifact ADD CONSTRAINT artifact_kind_check CHECK (kind IN (
    'glb', 'thumb', 'dem', 'ortho', 'frames', 'init_ply',
    'ply', 'sog', 'height', 'colliders',
    'height_edit', 'cover', 'flow', 'material', 'plugin', 'lod'));

-- ------------------------------------------------------------------ plugins

-- What blocks there are to draw with. The XML is the process server's own
-- plugin description; `bundled` is a copy that ships with the client
-- (client/flow/palette/plugins/), `runner` is one a process server reported.
-- The world does not interpret any of it — it keeps it so that a flow drawn
-- against a plugin can still be drawn after that plugin has moved on.
CREATE TABLE elx_plugin (
    id         text PRIMARY KEY,
    name       text NOT NULL,
    xml_sha256 text NOT NULL REFERENCES artifact (sha256),
    source     text NOT NULL CHECK (source IN ('bundled', 'runner')),
    seen_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE elx_plugin ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON elx_plugin FOR SELECT USING (true);
GRANT SELECT ON elx_plugin TO anon, player, admin;

-- -------------------------------------------------------------------- flows

CREATE TABLE flow (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id     uuid NOT NULL REFERENCES area (id) ON DELETE CASCADE,
    name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
    elx_sha256  text NOT NULL REFERENCES artifact (sha256),
    layout      jsonb NOT NULL DEFAULT '{}'::jsonb,
    rev         bigint NOT NULL DEFAULT 1,
    created_by  uuid,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);
CREATE UNIQUE INDEX flow_name_idx ON flow (area_id, name) WHERE deleted_at IS NULL;
CREATE INDEX flow_area_idx ON flow (area_id);

-- Invariant 6: who may see and change a land's logic is decided here. Whoever
-- builds on the land writes it; whoever approves for it reads it, because a
-- flow is part of what they are being asked to say yes to.
ALTER TABLE flow ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_rights ON flow FOR SELECT
USING (is_area_proposer(area_id) OR is_area_approver(area_id));
GRANT SELECT ON flow TO player, admin;

-- ----------------------------------------------------------------- saving

-- One flow, saved. Compare-and-swap on `rev`, so a second tab that loaded the
-- same flow cannot quietly win: it is told to reload instead. p_rev = 0 means
-- "this is new". The ELX must already be a registered artifact of kind
-- 'flow' — the tab PUTs the file and calls register_artifact before this.
CREATE FUNCTION save_flow(p_id uuid, p_area uuid, p_name text,
                          p_elx_sha256 text, p_layout jsonb,
                          p_rev bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    cur    flow%ROWTYPE;
    nm     text := btrim(p_name);
    newrev bigint;
BEGIN
    IF NOT is_area_proposer(p_area) THEN
        RAISE EXCEPTION 'you do not build on that land' USING errcode = '42501';
    END IF;
    IF nm = '' THEN
        RAISE EXCEPTION 'a flow needs a name';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM artifact
                   WHERE artifact.sha256 = p_elx_sha256 AND artifact.kind = 'flow') THEN
        RAISE EXCEPTION 'that is not a flow file';
    END IF;
    IF EXISTS (SELECT 1 FROM flow f
               WHERE f.area_id = p_area AND f.name = nm AND f.deleted_at IS NULL
                 AND f.id IS DISTINCT FROM p_id) THEN
        RAISE EXCEPTION '% is already used on this land', nm;
    END IF;

    SELECT * INTO cur FROM flow WHERE flow.id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        INSERT INTO flow (id, area_id, name, elx_sha256, layout, created_by)
        VALUES (coalesce(p_id, gen_random_uuid()), p_area, nm, p_elx_sha256,
                coalesce(p_layout, '{}'::jsonb), current_user_id())
        RETURNING flow.id, flow.rev INTO p_id, newrev;
        RETURN jsonb_build_object('id', p_id, 'rev', newrev);
    END IF;

    IF cur.area_id <> p_area THEN
        RAISE EXCEPTION 'a flow does not move between lands';
    END IF;
    IF cur.rev <> p_rev THEN
        RAISE EXCEPTION 'this flow was changed in another tab — reload it';
    END IF;
    UPDATE flow
    SET name = nm, elx_sha256 = p_elx_sha256,
        layout = coalesce(p_layout, '{}'::jsonb),
        rev = flow.rev + 1, updated_at = now(), deleted_at = NULL
    WHERE flow.id = p_id
    RETURNING flow.rev INTO newrev;
    RETURN jsonb_build_object('id', p_id, 'rev', newrev);
END
$$;
GRANT EXECUTE ON FUNCTION save_flow(uuid, uuid, text, text, jsonb, bigint)
TO player, admin;

-- Gone for everybody on the land, and the ELX file stays where it is: it is
-- immutable and something else may point at it (Invariant 1).
CREATE FUNCTION delete_flow(p_id uuid, p_rev bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    cur flow%ROWTYPE;
BEGIN
    SELECT * INTO cur FROM flow WHERE flow.id = p_id FOR UPDATE;
    IF NOT FOUND OR cur.deleted_at IS NOT NULL THEN RETURN false; END IF;
    IF NOT is_area_proposer(cur.area_id) THEN
        RAISE EXCEPTION 'you do not build on that land' USING errcode = '42501';
    END IF;
    IF cur.rev <> p_rev THEN
        RAISE EXCEPTION 'this flow was changed in another tab — reload it';
    END IF;
    UPDATE flow SET deleted_at = now(), rev = flow.rev + 1 WHERE flow.id = p_id;
    RETURN true;
END
$$;
GRANT EXECUTE ON FUNCTION delete_flow(uuid, bigint) TO player, admin;

-- ------------------------------------------------------------- the palette

-- Setup calls this once with the bundled plugin set, and again whenever a
-- hash has moved. Each XML is an artifact already (the tab PUT it), so all
-- this does is say which id the world saw under which hash.
CREATE FUNCTION bundle_plugins(p_plugins jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    n int := 0;
BEGIN
    IF current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin bundles plugins' USING errcode = '42501';
    END IF;
    INSERT INTO elx_plugin (id, name, xml_sha256, source)
    SELECT p ->> 'id', coalesce(p ->> 'name', p ->> 'id'), p ->> 'xml_sha256', 'bundled'
    FROM jsonb_array_elements(p_plugins) AS p
    ON CONFLICT (id) DO UPDATE
    SET name = excluded.name, xml_sha256 = excluded.xml_sha256,
        source = excluded.source, seen_at = now();
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END
$$;
GRANT EXECUTE ON FUNCTION bundle_plugins(jsonb) TO admin;

-- ---------------------------------------------------------- the file store

-- db/0051's can_write, with the flow file's extension. The store is told what
-- may be written by the database and by nothing else (Invariant 6), so an ELX
-- that nothing has allowed is a 403 from nginx or from server/ alike.
CREATE OR REPLACE FUNCTION can_write(path text, sha256 text, bytes bigint DEFAULT 0)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid   uuid := current_user_id();
    wid   uuid;
    m     text [];
    known boolean;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = 'PT401';
    END IF;
    IF can_write.sha256 IS NULL OR can_write.sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'a valid sha256 must be declared' USING errcode = 'PT403';
    END IF;
    known := EXISTS (SELECT 1 FROM artifact a WHERE a.sha256 = can_write.sha256);

    SELECT id INTO wid FROM worker WHERE user_id = uid;

    -- /jobs/{atom_id}/{name} — intermediate results, reserved by the claim.
    m := regexp_match(path, '^/jobs/([0-9]+)/[A-Za-z0-9._-]+$');
    IF m IS NOT NULL THEN
        IF known THEN
            RAISE EXCEPTION 'artifact already registered' USING errcode = 'PT403';
        END IF;
        IF EXISTS (SELECT 1 FROM atom
                   WHERE id = m[1]::bigint AND state = 'claimed'
                     AND worker_id = wid) THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'atom % is not claimed by you', m[1] USING errcode = 'PT403';
    END IF;

    -- /assets/{sha}.glb|.webp|.elx — catalog uploads and flow files, by any
    -- authenticated user. .elx since db/0155: a flow is a file in the store
    -- like a model is, and which land it may be pointed at is save_flow's
    -- question, not this one's.
    m := regexp_match(path, '^/assets/([0-9a-f]{64})\.(glb|webp|elx)$');
    IF m IS NOT NULL THEN
        IF m[1] <> can_write.sha256 THEN
            RAISE EXCEPTION 'path does not match the declared sha256'
                USING errcode = 'PT403';
        END IF;
        RETURN;
    END IF;

    -- /tiles/{z}/{x}/{y}/{sha}.sog|.r16|.json — the tile's splats, its
    -- heightmap and its colliders. Only the worker holding that tile's sog.
    m := regexp_match(path,
        '^/tiles/([0-9]+)/([0-9]+)/([0-9]+)/([0-9a-f]{64})\.(sog|r16|json)$');
    IF m IS NOT NULL THEN
        IF m[4] <> can_write.sha256 THEN
            RAISE EXCEPTION 'path does not match the declared sha256'
                USING errcode = 'PT403';
        END IF;
        IF EXISTS (SELECT 1 FROM atom a
                   JOIN job j ON j.id = a.job_id
                   WHERE a.op = 'sog' AND a.worker_id = wid
                     AND a.state IN ('claimed', 'submitted', 'verified')
                     AND j.z = m[1]::int AND j.x = m[2]::int AND j.y = m[3]::int) THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'you hold no sog atom for %/%/%', m[1], m[2], m[3]
            USING errcode = 'PT403';
    END IF;

    RAISE EXCEPTION 'path % is not writable', path USING errcode = 'PT403';
END
$$;

-- ---------------------------------------------------------------- the api

CREATE VIEW api.flow WITH (security_invoker = true) AS SELECT * FROM public.flow;
CREATE VIEW api.elx_plugin WITH (security_invoker = true)
AS SELECT * FROM public.elx_plugin;
GRANT SELECT ON api.flow TO player, admin;
GRANT SELECT ON api.elx_plugin TO anon, player, admin;

CREATE FUNCTION api.save_flow(id uuid, area uuid, name text, elx_sha256 text,
                              layout jsonb, rev bigint) RETURNS jsonb
LANGUAGE sql VOLATILE
AS $$SELECT public.save_flow(id, area, name, elx_sha256, layout, rev)$$;
GRANT EXECUTE ON FUNCTION api.save_flow(uuid, uuid, text, text, jsonb, bigint)
TO player, admin;

CREATE FUNCTION api.delete_flow(id uuid, rev bigint) RETURNS boolean
LANGUAGE sql VOLATILE AS $$SELECT public.delete_flow(id, rev)$$;
GRANT EXECUTE ON FUNCTION api.delete_flow(uuid, bigint) TO player, admin;

CREATE FUNCTION api.bundle_plugins(plugins jsonb) RETURNS int
LANGUAGE sql VOLATILE AS $$SELECT public.bundle_plugins(plugins)$$;
GRANT EXECUTE ON FUNCTION api.bundle_plugins(jsonb) TO admin;
