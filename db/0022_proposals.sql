-- 0022_proposals.sql — the proposal path (WP4.3): what an `edit` grantee's
-- write becomes when they may not write the world themselves.
--
-- A proposal carries a diff, and a diff is a list of world ops applied in
-- array order:
--
--   {"ops": [
--     {"op": "insert", "table": "feature",  "values": {...}},
--     {"op": "update", "table": "instance", "id": "<uuid>", "values": {...}},
--     {"op": "delete", "table": "feature",  "id": "<uuid>"}
--   ]}
--
-- `table` is feature or instance; `values` holds the columns to write, a
-- feature's geom as GeoJSON. An insert may name its own id; an update writes
-- only the keys it names; a delete sets deleted_at, because the world is
-- filtered on it rather than emptied (db/0005_jobs.sql, db/0013_world.sql).
-- The row's area is the proposal's area and never what the diff says, so a
-- proposal can only write inside the area it was made against.
--
-- Invariant 6: propose() and approve() are plain invoker functions — the
-- `propose` and `approve` policies of db/0003_rls.sql are what authorise them,
-- and this adds no authority of its own. merge_proposal() is the exception: it
-- is SECURITY DEFINER because it writes the world under the area owner's
-- authority, and it therefore checks that authority itself.
--
-- Invariant 4: applying an op is an ordinary feature/instance write, so the
-- triggers in db/0004_tiles.sql are what mark the tiles dirty. Nothing here
-- touches tile.

-- A geometry as the client has it: GeoJSON, 4326, forced to 3D for
-- feature.geom's GeometryZ. Absent or json null means "leave it alone".
CREATE FUNCTION diff_geom(g jsonb) RETURNS geometry
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE WHEN jsonb_typeof(g) = 'object'
    THEN st_setsrid(st_force3d(st_geomfromgeojson(g)), 4326) END;
$$;

-- Checked at propose time so a proposal that could never merge is never made.
CREATE FUNCTION valid_diff(diff jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
SELECT coalesce(jsonb_typeof(diff -> 'ops') = 'array', false) AND coalesce(bool_and(
    o ->> 'op' IN ('insert', 'update', 'delete')
    AND o ->> 'table' IN ('feature', 'instance')
    AND (o ->> 'op' = 'insert' OR (o ->> 'id')::uuid IS NOT NULL)
    AND (o ->> 'op' = 'delete' OR jsonb_typeof(o -> 'values') = 'object')), true)
FROM jsonb_array_elements(CASE WHEN jsonb_typeof(diff -> 'ops') = 'array'
    THEN diff -> 'ops' ELSE '[]'::jsonb END) AS o;
$$;

CREATE FUNCTION propose(area_id uuid, diff jsonb) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
    pid uuid;
BEGIN
    IF NOT valid_diff(propose.diff) THEN
        RAISE EXCEPTION 'malformed diff' USING errcode = 'PT400';
    END IF;
    INSERT INTO proposal (area_id, author_id, diff)
    VALUES (propose.area_id, current_user_id(), propose.diff)
    RETURNING id INTO pid;
    RETURN pid;
END
$$;

-- Returns how many approvals the proposal now has; the area's rules say how
-- many merge_proposal() will want.
CREATE FUNCTION approve(proposal_id uuid) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
    n  int;
    st text;
BEGIN
    SELECT p.state INTO st FROM proposal p WHERE p.id = approve.proposal_id;
    IF st IS DISTINCT FROM 'open' THEN
        RAISE EXCEPTION 'proposal % is not open', approve.proposal_id
            USING errcode = 'PT409';
    END IF;
    INSERT INTO approval (proposal_id, reviewer_id)
    SELECT approve.proposal_id, current_user_id()
    WHERE NOT EXISTS (
        SELECT 1 FROM approval a
        WHERE a.proposal_id = approve.proposal_id
          AND a.reviewer_id = current_user_id());
    SELECT count(*) INTO n FROM approval a WHERE a.proposal_id = approve.proposal_id;
    RETURN n;
END
$$;

-- ---------------------------------------------------------------- the diff

CREATE FUNCTION apply_feature_op(area_id uuid, op jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    act text := op ->> 'op';
    v   jsonb := coalesce(op -> 'values', '{}'::jsonb);
    fid uuid := (op ->> 'id')::uuid;
BEGIN
    IF act = 'insert' THEN
        INSERT INTO feature (id, area_id, kind, geom, props)
        VALUES (coalesce(fid, gen_random_uuid()), apply_feature_op.area_id,
                v ->> 'kind', diff_geom(v -> 'geom'),
                coalesce(v -> 'props', '{}'::jsonb));
    ELSIF act = 'update' THEN
        UPDATE feature f SET
            kind = coalesce(v ->> 'kind', f.kind),
            geom = coalesce(diff_geom(v -> 'geom'), f.geom),
            props = coalesce(v -> 'props', f.props)
        WHERE f.id = fid AND f.area_id = apply_feature_op.area_id
          AND f.deleted_at IS NULL;
    ELSE
        UPDATE feature f SET deleted_at = now()
        WHERE f.id = fid AND f.area_id = apply_feature_op.area_id
          AND f.deleted_at IS NULL;
    END IF;
END
$$;

CREATE FUNCTION apply_instance_op(area_id uuid, op jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    act text := op ->> 'op';
    v   jsonb := coalesce(op -> 'values', '{}'::jsonb);
    iid uuid := (op ->> 'id')::uuid;
BEGIN
    IF act = 'insert' THEN
        INSERT INTO instance (id, area_id, san, lon, lat, h,
                              yaw, pitch, roll, scale, props)
        VALUES (coalesce(iid, gen_random_uuid()), apply_instance_op.area_id,
                v ->> 'san', (v ->> 'lon')::double precision,
                (v ->> 'lat')::double precision,
                coalesce((v ->> 'h')::double precision, 0),
                coalesce((v ->> 'yaw')::real, 0),
                coalesce((v ->> 'pitch')::real, 0),
                coalesce((v ->> 'roll')::real, 0),
                coalesce((v ->> 'scale')::real, 1),
                coalesce(v -> 'props', '{}'::jsonb));
    ELSIF act = 'update' THEN
        UPDATE instance i SET
            san = coalesce(v ->> 'san', i.san),
            lon = coalesce((v ->> 'lon')::double precision, i.lon),
            lat = coalesce((v ->> 'lat')::double precision, i.lat),
            h = coalesce((v ->> 'h')::double precision, i.h),
            yaw = coalesce((v ->> 'yaw')::real, i.yaw),
            pitch = coalesce((v ->> 'pitch')::real, i.pitch),
            roll = coalesce((v ->> 'roll')::real, i.roll),
            scale = coalesce((v ->> 'scale')::real, i.scale),
            props = coalesce(v -> 'props', i.props)
        WHERE i.id = iid AND i.area_id = apply_instance_op.area_id
          AND i.deleted_at IS NULL;
    ELSE
        UPDATE instance i SET deleted_at = now()
        WHERE i.id = iid AND i.area_id = apply_instance_op.area_id
          AND i.deleted_at IS NULL;
    END IF;
END
$$;

CREATE FUNCTION apply_op(area_id uuid, op jsonb) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF op ->> 'table' = 'feature' THEN
        PERFORM apply_feature_op(apply_op.area_id, apply_op.op);
    ELSIF op ->> 'table' = 'instance' THEN
        PERFORM apply_instance_op(apply_op.area_id, apply_op.op);
    ELSE
        RAISE EXCEPTION 'diff op names no world table: %', apply_op.op
            USING errcode = 'PT400';
    END IF;
END
$$;

-- ------------------------------------------------------------------- merge

-- Invariant 6: this is the one function here that writes the world without an
-- RLS policy behind it, so the area's authority is checked in full: an
-- approver merges, and only once the area's rules have been satisfied.
-- Returns the number of ops applied.
CREATE FUNCTION merge_proposal(proposal_id uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    p    proposal%rowtype;
    need int;
    got  int;
    op   jsonb;
    n    int := 0;
BEGIN
    SELECT * INTO p FROM proposal
    WHERE proposal.id = merge_proposal.proposal_id FOR UPDATE;
    IF NOT found THEN
        RAISE EXCEPTION 'no proposal %', merge_proposal.proposal_id
            USING errcode = 'PT404';
    END IF;
    IF NOT is_area_approver(p.area_id) THEN
        RAISE EXCEPTION 'not an approver of area %', p.area_id
            USING errcode = 'PT403';
    END IF;
    IF p.state <> 'open' THEN
        RAISE EXCEPTION 'proposal % is already %', p.id, p.state
            USING errcode = 'PT409';
    END IF;
    SELECT coalesce((a.rules ->> 'required_approvals')::int, 1) INTO need
    FROM area a WHERE a.id = p.area_id;
    SELECT count(*) INTO got FROM approval a WHERE a.proposal_id = p.id;
    IF got < need THEN
        RAISE EXCEPTION 'proposal % has % of % approvals', p.id, got, need
            USING errcode = 'PT409';
    END IF;

    FOR op IN SELECT jsonb_array_elements(p.diff -> 'ops') LOOP
        PERFORM apply_op(p.area_id, op);
        n := n + 1;
    END LOOP;
    UPDATE proposal SET state = 'merged' WHERE proposal.id = p.id;
    RETURN n;
END
$$;

-- Internals of the merge: reachable only from merge_proposal, which runs as
-- the definer and therefore keeps its own EXECUTE.
REVOKE ALL ON FUNCTION apply_op(uuid, jsonb), apply_feature_op(uuid, jsonb),
    apply_instance_op(uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION diff_geom(jsonb), valid_diff(jsonb)
TO anon, player, admin;
GRANT EXECUTE ON FUNCTION propose(uuid, jsonb), approve(uuid),
    merge_proposal(uuid) TO player, admin;

-- --------------------------------------------------------------------- api

CREATE FUNCTION api.propose(area_id uuid, diff jsonb) RETURNS uuid
LANGUAGE sql AS $$SELECT public.propose(area_id, diff)$$;

CREATE FUNCTION api.approve(proposal_id uuid) RETURNS int
LANGUAGE sql AS $$SELECT public.approve(proposal_id)$$;

CREATE FUNCTION api.merge_proposal(proposal_id uuid) RETURNS int
LANGUAGE sql AS $$SELECT public.merge_proposal(proposal_id)$$;

REVOKE ALL ON FUNCTION api.propose(uuid, jsonb), api.approve(uuid),
    api.merge_proposal(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.propose(uuid, jsonb), api.approve(uuid),
    api.merge_proposal(uuid) TO player, admin;

-- ------------------------------------------------------- grants and rules

-- `grant_` has no write policy (db/0003_rls.sql), so grants move only through
-- here — and only under the area's owner. Granting by email means an owner can
-- tell whether an address has an account; that is the price of a usable panel
-- when a uuid is the only other handle a player has, and it is bounded to
-- people who already own land.
CREATE FUNCTION set_grant(area_id uuid, email text, right_ text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid uuid;
BEGIN
    IF NOT is_area_owner(set_grant.area_id) THEN
        RAISE EXCEPTION 'only the owner of area % grants on it', set_grant.area_id
            USING errcode = 'PT403';
    END IF;
    SELECT u.id INTO uid FROM auth.user u WHERE u.email = lower(set_grant.email);
    IF uid IS NULL THEN
        RAISE EXCEPTION 'no account for %', set_grant.email USING errcode = 'PT404';
    END IF;
    IF uid = current_user_id() THEN
        RAISE EXCEPTION 'the owner already has every right' USING errcode = 'PT400';
    END IF;
    INSERT INTO grant_ (area_id, grantee_id, right_)
    VALUES (set_grant.area_id, uid, set_grant.right_)
    ON CONFLICT DO NOTHING;
    RETURN uid;
END
$$;

CREATE FUNCTION revoke_grant(area_id uuid, grantee_id uuid, right_ text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT is_area_owner(revoke_grant.area_id) THEN
        RAISE EXCEPTION 'only the owner of area % grants on it', revoke_grant.area_id
            USING errcode = 'PT403';
    END IF;
    DELETE FROM grant_ g
    WHERE g.area_id = revoke_grant.area_id
      AND g.grantee_id = revoke_grant.grantee_id
      AND g.right_ = revoke_grant.right_;
END
$$;

-- How many approvals a merge wants. Nothing else in `rules` is read yet, so it
-- is the only key this writes; the rest of the object is left alone.
CREATE FUNCTION set_required_approvals(area_id uuid, n int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    out jsonb;
BEGIN
    IF NOT is_area_owner(set_required_approvals.area_id) THEN
        RAISE EXCEPTION 'only the owner of area % sets its rules',
            set_required_approvals.area_id USING errcode = 'PT403';
    END IF;
    IF set_required_approvals.n < 1 THEN
        RAISE EXCEPTION 'an area needs at least one approval' USING errcode = 'PT400';
    END IF;
    UPDATE area a
    SET rules = coalesce(a.rules, '{}'::jsonb)
        || jsonb_build_object('required_approvals', set_required_approvals.n)
    WHERE a.id = set_required_approvals.area_id
    RETURNING a.rules INTO out;
    RETURN out;
END
$$;

-- --------------------------------------------------------- what to look at

-- The grants on an area, with the emails the owner typed to make them. Only
-- the owner sees the addresses; everyone else gets the ids the `grant_` table
-- already shows to all (db/0003_rls.sql).
CREATE FUNCTION area_grants(area_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'grantee_id', g.grantee_id, 'right_', g.right_,
    'email', CASE WHEN is_area_owner(area_grants.area_id)
                  THEN (SELECT u.email FROM auth.user u WHERE u.id = g.grantee_id) END)
    ORDER BY g.right_, g.grantee_id), '[]'::jsonb)
FROM grant_ g WHERE g.area_id = area_grants.area_id;
$$;

-- Every proposal this caller has a part in: theirs to review, or theirs to
-- have made. `mine` says which, and `approvals`/`required` say how close it is.
CREATE FUNCTION my_proposals(state text DEFAULT 'open') RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'area_id', p.area_id, 'author_id', p.author_id,
    'state', p.state, 'diff', p.diff, 'created_at', p.created_at,
    'mine', p.author_id = current_user_id(),
    'may_approve', is_area_approver(p.area_id),
    'approved', EXISTS (SELECT 1 FROM approval a
                        WHERE a.proposal_id = p.id
                          AND a.reviewer_id = current_user_id()),
    'approvals', (SELECT count(*) FROM approval a WHERE a.proposal_id = p.id),
    'required', coalesce((ar.rules ->> 'required_approvals')::int, 1))
    ORDER BY p.created_at DESC), '[]'::jsonb)
FROM proposal p
JOIN area ar ON ar.id = p.area_id
WHERE p.state = my_proposals.state
  AND (p.author_id = current_user_id() OR is_area_approver(p.area_id));
$$;

GRANT EXECUTE ON FUNCTION area_grants(uuid), my_proposals(text) TO anon, player, admin;
GRANT EXECUTE ON FUNCTION set_grant(uuid, text, text),
    revoke_grant(uuid, uuid, text), set_required_approvals(uuid, int)
TO player, admin;

CREATE FUNCTION api.set_grant(area_id uuid, email text, right_ text) RETURNS uuid
LANGUAGE sql AS $$SELECT public.set_grant(area_id, email, right_)$$;
CREATE FUNCTION api.revoke_grant(area_id uuid, grantee_id uuid, right_ text) RETURNS void
LANGUAGE sql AS $$SELECT public.revoke_grant(area_id, grantee_id, right_)$$;
CREATE FUNCTION api.set_required_approvals(area_id uuid, n int) RETURNS jsonb
LANGUAGE sql AS $$SELECT public.set_required_approvals(area_id, n)$$;
CREATE FUNCTION api.area_grants(area_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.area_grants(area_id)$$;
CREATE FUNCTION api.my_proposals(state text DEFAULT 'open') RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.my_proposals(state)$$;

REVOKE ALL ON FUNCTION api.set_grant(uuid, text, text),
    api.revoke_grant(uuid, uuid, text), api.set_required_approvals(uuid, int),
    api.area_grants(uuid), api.my_proposals(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.area_grants(uuid), api.my_proposals(text)
TO anon, player, admin;
GRANT EXECUTE ON FUNCTION api.set_grant(uuid, text, text),
    api.revoke_grant(uuid, uuid, text), api.set_required_approvals(uuid, int)
TO player, admin;
