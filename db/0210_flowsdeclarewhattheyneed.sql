-- 0210_flowsdeclarewhattheyneed.sql — a product's flow says what it needs,
-- and a thing on somebody's land runs no more than its owner said yes to.
--
-- TASKS-live.md LV.9. product.json's `needs` (tools/register.py) travels
-- with each version (db/0209):
--
--   ports  "own" | "area"          write its own ports, or the whole land's
--   pay    {"max_per_day": n}      spend up to n credits a day
--   move   "own"                   move its own parts (LV.1)
--   emit   true                    raise events
--   hold   true                    take, drop and give (LV.4)
--
-- `instance.consent` is what the owner accepted, and for which version:
-- placing a thing is saying yes to what it needs then. When the pointer
-- moves to a version that asks for more, the thing stays on the version it
-- has, the Place panel says what the new one asks, and Allow moves it.
--
-- A right now resolves to a version, not only to a hash: a fix that changes
-- only the flow is still a fix, and a change that is not one is still not
-- one. right_sha (db/0207) is the file of that version.

ALTER TABLE instance ADD COLUMN consent jsonb;

-- The version a right was acquired at, by number: two versions made in the
-- same second are still one after the other.
ALTER TABLE asset_right ADD COLUMN version_id bigint REFERENCES asset_version (id);
UPDATE asset_right r SET version_id = (
    SELECT v.id FROM asset_version v WHERE v.san = r.san AND v.channel = 'current'
      AND v.at <= r.acquired_at ORDER BY v.id DESC LIMIT 1);

-- db/0207's grant_right, remembering the version.
CREATE OR REPLACE FUNCTION grant_right(o store_order, a asset) RETURNS void
LANGUAGE sql SET search_path = public AS $$
INSERT INTO asset_right (san, holder_id, ref, follow, sha256, until, version_id)
VALUES (o.san, o.buyer, o.ref,
        CASE WHEN a.policy = 'pinned' THEN 'pinned' ELSE 'current' END,
        a.pointer ->> 'current',
        CASE WHEN o.term IS NOT NULL THEN now() + o.term * o.qty END,
        (latest_version(o.san, 'current')).id)
ON CONFLICT (san, holder_id) DO UPDATE
SET until = CASE WHEN o.term IS NOT NULL
    THEN greatest(asset_right.until, now()) + o.term * o.qty ELSE asset_right.until END
$$;

-- The version a right follows now (db/0207's rules, by version).
CREATE FUNCTION right_version(p_san text, p_holder uuid) RETURNS bigint
LANGUAGE sql STABLE SET search_path = public AS $$
WITH r AS (SELECT * FROM asset_right WHERE san = p_san AND holder_id = p_holder)
SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM r) THEN (latest_version(p_san, 'current')).id
    WHEN (SELECT follow FROM r) = 'pinned' THEN (SELECT version_id FROM r)
    WHEN (SELECT until FROM r) IS NOT NULL THEN CASE
        WHEN (SELECT until FROM r) > now() THEN (latest_version(p_san, 'current')).id
        ELSE coalesce((latest_version(p_san, 'legacy')).id, (SELECT version_id FROM r)) END
    ELSE coalesce((SELECT v.id FROM asset_version v, r
                   WHERE v.san = p_san AND v.channel = 'current' AND v.fix
                     AND v.id > coalesce(r.version_id, 0) ORDER BY v.id DESC LIMIT 1),
                  (SELECT version_id FROM r), (latest_version(p_san, 'current')).id) END
$$;

CREATE OR REPLACE FUNCTION right_sha(p_san text, p_holder uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce((SELECT sha256 FROM asset_version WHERE id = right_version(p_san, p_holder)),
                (SELECT pointer ->> 'current' FROM asset WHERE san = p_san))
$$;

-- Whether what `asks` for is within what `allowed` says yes to.
CREATE FUNCTION needs_within(asks jsonb, allowed jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
SELECT (NOT asks ? 'ports' OR asks ->> 'ports' = allowed ->> 'ports'
        OR (asks ->> 'ports' = 'own' AND allowed ->> 'ports' = 'area'))
   AND (NOT asks ? 'pay' OR coalesce((asks #>> '{pay,max_per_day}')::numeric, 0)
        <= coalesce((allowed #>> '{pay,max_per_day}')::numeric, 0))
   AND (NOT asks ? 'move' OR allowed ? 'move')
   AND (NOT coalesce((asks ->> 'emit')::boolean, false)
        OR coalesce((allowed ->> 'emit')::boolean, false))
   AND (NOT coalesce((asks ->> 'hold')::boolean, false)
        OR coalesce((allowed ->> 'hold')::boolean, false))
$$;

-- What a version asks for beyond what was allowed, in the Place panel's words.
CREATE FUNCTION needs_words(asks jsonb, allowed jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
SELECT string_agg(w, ', ') FROM (
    SELECT 'pay up to ' || (asks #>> '{pay,max_per_day}') || ' a day' AS w
    WHERE asks ? 'pay' AND NOT needs_within(jsonb_build_object('pay', asks -> 'pay'), allowed)
    UNION ALL SELECT CASE asks ->> 'ports' WHEN 'area' THEN 'change anything on the land'
        ELSE 'change its own ports' END
    WHERE asks ? 'ports' AND NOT needs_within(jsonb_build_object('ports', asks -> 'ports'), allowed)
    UNION ALL SELECT 'move its parts'
    WHERE asks ? 'move' AND NOT allowed ? 'move'
    UNION ALL SELECT 'raise events'
    WHERE coalesce((asks ->> 'emit')::boolean, false)
      AND NOT coalesce((allowed ->> 'emit')::boolean, false)
    UNION ALL SELECT 'take and give things'
    WHERE coalesce((asks ->> 'hold')::boolean, false)
      AND NOT coalesce((allowed ->> 'hold')::boolean, false)) x
$$;

GRANT EXECUTE ON FUNCTION right_version(text, uuid), needs_within(jsonb, jsonb),
    needs_words(jsonb, jsonb) TO anon, player, admin, flow;

-- ------------------------------------------------------------ the thing

-- The version its owner's right would give it now.
CREATE FUNCTION offered_version(i instance) RETURNS asset_version
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT * FROM asset_version WHERE id = right_version(i.san,
    (SELECT owner_id FROM area WHERE id = i.area_id))
$$;

-- The version a thing runs: what is offered, when the owner has said yes to
-- everything it needs; otherwise the one they did say yes to.
CREATE FUNCTION instance_version(p_instance uuid) RETURNS asset_version
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
    i    instance%ROWTYPE;
    want asset_version%ROWTYPE;
    had  asset_version%ROWTYPE;
BEGIN
    SELECT * INTO i FROM instance WHERE id = p_instance;
    want := offered_version(i);
    IF i.consent IS NULL OR needs_within(want.needs, i.consent -> 'needs') THEN
        RETURN want;
    END IF;
    SELECT * INTO had FROM asset_version WHERE id = (i.consent ->> 'version')::bigint;
    RETURN coalesce(had, want);
END
$$;

CREATE FUNCTION instance_sha(p_instance uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce((instance_version(p_instance)).sha256,
    (SELECT a.sha256 FROM instance i JOIN asset a ON a.san = i.san WHERE i.id = p_instance))
$$;

GRANT EXECUTE ON FUNCTION offered_version(instance), instance_version(uuid),
    instance_sha(uuid) TO anon, player, admin, flow;

-- Placing a thing is saying yes to what it needs as it is placed.
CREATE FUNCTION instance_consent_default() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v asset_version%ROWTYPE;
BEGIN
    IF new.consent IS NULL THEN
        v := offered_version(new);
        new.consent := jsonb_build_object('version', v.id,
            'needs', coalesce(v.needs, '{}'::jsonb));
    END IF;
    RETURN new;
END
$$;
-- Named to run after every other BEFORE INSERT trigger: the land it stands
-- on (instance_area_default) decides whose right it follows.
CREATE TRIGGER instance_z_consent BEFORE INSERT ON instance
FOR EACH ROW EXECUTE FUNCTION instance_consent_default();

UPDATE instance i SET consent = (SELECT jsonb_build_object('version', v.id, 'needs', v.needs)
                                 FROM offered_version(i) v)
WHERE i.consent IS NULL;


-- ------------------------------------------------------------ the owner

-- What the Place panel says about a thing: the version it runs, and — when
-- its product has moved on to a version that asks for more — what that one
-- asks for.
CREATE FUNCTION update_waiting(p_instance uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
    i    instance%ROWTYPE;
    runs asset_version%ROWTYPE;
    want asset_version%ROWTYPE;
BEGIN
    SELECT * INTO i FROM instance WHERE id = p_instance;
    IF i.id IS NULL THEN RETURN NULL; END IF;
    runs := instance_version(p_instance);
    want := offered_version(i);
    RETURN jsonb_build_object('name', thing_words(p_instance),
        'runs', jsonb_build_object('version', runs.id, 'sha256', runs.sha256,
                                   'flow_sha256', runs.flow_sha256, 'needs', runs.needs),
        'waiting', want.id IS DISTINCT FROM runs.id,
        'offered', jsonb_build_object('version', want.id, 'sha256', want.sha256,
                                      'flow_sha256', want.flow_sha256, 'needs', want.needs),
        'asks', needs_words(want.needs, coalesce(i.consent -> 'needs', '{}')));
END
$$;

-- Allow: the owner says yes to what the offered version needs, and the thing
-- moves to it. Whoever may change the land directly says so; nobody else.
CREATE FUNCTION allow_update(p_instance uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    i    instance%ROWTYPE;
    want asset_version%ROWTYPE;
BEGIN
    SELECT * INTO i FROM instance WHERE id = p_instance AND deleted_at IS NULL;
    IF i.id IS NULL OR NOT is_area_writer(i.area_id) THEN
        RAISE EXCEPTION 'only who owns the land says yes for it' USING errcode = '42501';
    END IF;
    want := offered_version(i);
    UPDATE instance SET consent = jsonb_build_object('version', want.id,
        'needs', coalesce(want.needs, '{}'::jsonb))
    WHERE id = p_instance;
    RETURN update_waiting(p_instance);
END
$$;

GRANT EXECUTE ON FUNCTION update_waiting(uuid) TO anon, player, admin;
GRANT EXECUTE ON FUNCTION allow_update(uuid) TO player, admin;

-- What the page draws for the things near it: each one's own file.
CREATE FUNCTION things_files(p_ids uuid []) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_object_agg(id, instance_sha(id)), '{}'::jsonb)
FROM unnest(p_ids) id
$$;

GRANT EXECUTE ON FUNCTION things_files(uuid []) TO anon, player, admin;

-- ---------------------------------------------------------- the compiler

-- db/0205's tile_world, each thing drawn from the version it runs.
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
            'sha256', instance_sha(i.id), 'canon_version', a.canon_version, 'parts', a.parts,
            'lon', i.lon, 'lat', i.lat, 'h', i.h,
            'yaw', i.yaw, 'pitch', i.pitch, 'roll', i.roll,
            'scale', i.scale) ORDER BY i.id)
        FROM instance i
        JOIN asset a ON a.san = i.san
        WHERE i.deleted_at IS NULL AND NOT i.carry
          AND st_intersects(i.geom, tile_bbox(z, x, y))), '[]'::jsonb));
$$;

CREATE OR REPLACE FUNCTION instance_glbs(z int, x int, y int) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
SELECT coalesce(jsonb_agg(DISTINCT to_jsonb(instance_sha(i.id))), '[]'::jsonb)
FROM instance i
WHERE i.deleted_at IS NULL AND NOT i.carry AND st_intersects(i.geom, tile_bbox(z, x, y));
$$;

-- ---------------------------------------------------------------- the api

CREATE OR REPLACE VIEW api.instance WITH (security_invoker = true)
AS SELECT * FROM public.instance;

CREATE FUNCTION api.update_waiting(p_instance uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.update_waiting(p_instance)$$;
CREATE FUNCTION api.allow_update(p_instance uuid) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.allow_update(p_instance)$$;
CREATE FUNCTION api.things_files(p_ids uuid []) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.things_files(p_ids)$$;
GRANT EXECUTE ON FUNCTION api.update_waiting(uuid), api.things_files(uuid [])
TO anon, player, admin;
GRANT EXECUTE ON FUNCTION api.allow_update(uuid) TO player, admin;
