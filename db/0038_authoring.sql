-- 0038_authoring.sql — make your own ground, and retry a render that failed.
--
-- Two things a person still could not do from the application. Both were found
-- by walking the workflow against a live database rather than by reading:
--
--   1. There is no way to create an area. `area` has no INSERT grant (0003) and
--      no RPC, so every area in this repo is made by raw SQL — the importer
--      (server/splatworld/importer.py), the seeds, six e2e specs and nine pgTAP
--      files. client/js/areas.js can list areas, grant rights on them, propose
--      and approve, but not make one. A player with an account and a browser
--      owns no ground and cannot get any.
--   2. A failed atom is the end of the road. Three bad attempts and the tile
--      cannot be compiled at that version again however transient the cause.
--      atom_state_guard (0015) has always allowed failed -> ready; nothing
--      performed the transition. recheck_atom only takes a `verified` one.
--
-- No new columns: area_view (0021) already publishes `rules`, so an area's name
-- lives there and the schema is untouched.

-- ------------------------------------------------------------------- areas

-- GeoJSON rather than WKT, because the caller is a browser holding a drawn
-- polygon. `detail` 0 is GeoServer's blank number and 0032's trigger turns it
-- into the baseline, so this passes it through rather than having a second
-- opinion about what "unset" means.
CREATE FUNCTION create_area(p_geojson jsonb, p_detail int DEFAULT 0,
                            p_name text DEFAULT '') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid uuid := current_user_id();
    g   geometry;
    aid uuid;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    BEGIN
        g := st_setsrid(st_geomfromgeojson(p_geojson), 4326);
    EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'that is not GeoJSON geometry: %', sqlerrm;
    END;
    IF st_geometrytype(g) <> 'ST_Polygon' THEN
        RAISE EXCEPTION 'an area is one polygon, not %', st_geometrytype(g);
    END IF;
    IF NOT st_isvalid(g) THEN
        RAISE EXCEPTION 'the outline is not valid: %', st_isvalidreason(g);
    END IF;

    -- Overlapping someone else's area is deliberately allowed: 1 037 system
    -- areas cover Switzerland (docs/seed-ch.md), so refusing overlap would
    -- refuse every area a player could draw there. What overlap grants is
    -- ensure_job over those tiles — volunteered browser compute, not a write
    -- on anybody's features, which is_area_writer still decides per area.
    INSERT INTO area (geom, owner_id, detail, rules)
    VALUES (g, uid, p_detail,
            jsonb_build_object('required_approvals', 1)
            || CASE WHEN coalesce(p_name, '') = '' THEN '{}'::jsonb
                    ELSE jsonb_build_object('name', p_name) END)
    RETURNING area.id INTO aid;
    RETURN aid;
END
$$;

-- Compiling deeper has to invalidate the tiles that cover the area: no feature
-- changed, so the dirty trigger cannot see this. Invariant 4 still holds — this
-- marks dirty and bumps expected_version, nothing else — and it takes the tile
-- locks coarse before fine, as every other writer does (0010_lockorder).
-- Lowering the detail leaves what is already published alone.
CREATE FUNCTION set_area_detail(p_area uuid, p_detail int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a area%rowtype;
    n int := 0;
BEGIN
    SELECT * INTO a FROM area WHERE area.id = p_area FOR UPDATE;
    IF a.id IS NULL THEN
        RAISE EXCEPTION 'no such area %', p_area;
    END IF;
    IF NOT is_area_owner(p_area) THEN
        RAISE EXCEPTION 'not your area' USING errcode = '42501';
    END IF;
    UPDATE area SET detail = p_detail WHERE area.id = p_area;
    SELECT a2.detail INTO p_detail FROM area a2 WHERE a2.id = p_area;
    IF p_detail > a.detail THEN
        INSERT INTO tile (z, x, y, dirty, expected_version)
        SELECT t.z, t.x, t.y, true, 1
        FROM tiles_for_geom(a.geom, 6, p_detail) AS t
        ORDER BY t.z, t.x, t.y
        ON CONFLICT (z, x, y) DO UPDATE
        SET dirty = true, expected_version = tile.expected_version + 1;
        GET DIAGNOSTICS n = ROW_COUNT;
    END IF;
    RETURN n;
END
$$;

-- Deleting an area would orphan the features that carry the world, so emptying
-- it first is the caller's job and saying so beats a cascade.
CREATE FUNCTION delete_area(p_area uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT is_area_owner(p_area) THEN
        RAISE EXCEPTION 'not your area' USING errcode = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM feature f
               WHERE f.area_id = p_area AND f.deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM instance i
                  WHERE i.area_id = p_area AND i.deleted_at IS NULL) THEN
        RAISE EXCEPTION 'the area still holds features or instances';
    END IF;
    DELETE FROM area WHERE area.id = p_area;
END
$$;

-- ------------------------------------------------------------------ rescue

-- Attempts reset to zero: this is a person deciding to try again, not the
-- system retrying itself. An atom with dependencies goes back to `waiting` and
-- advance_atoms decides whether it is ready, so a reset cannot hand out work
-- whose inputs are gone.
CREATE FUNCTION reset_atom(p_atom bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a atom%rowtype;
    j job%rowtype;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = '28000';
    END IF;
    SELECT * INTO a FROM atom WHERE atom.id = p_atom FOR UPDATE;
    IF a.id IS NULL OR a.state <> 'failed' THEN
        RETURN false;
    END IF;
    SELECT * INTO j FROM job WHERE job.id = a.job_id;
    IF current_user_role() <> 'admin'
       AND NOT EXISTS (SELECT 1 FROM area ar
                       WHERE is_area_writer(ar.id)
                         AND st_intersects(ar.geom, tile_bbox(j.z, j.x, j.y))) THEN
        RAISE EXCEPTION 'not authorised for %/%/%', j.z, j.x, j.y
            USING errcode = '42501';
    END IF;
    UPDATE atom SET state = CASE WHEN cardinality(atom.deps) = 0 THEN 'ready'
                                 ELSE 'waiting' END,
                    attempts = 0, output_sha256 = NULL, result = NULL,
                    worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
    WHERE atom.id = p_atom;
    UPDATE job SET state = 'open'
    WHERE job.id = a.job_id AND job.state <> 'cancelled';
    PERFORM advance_atoms(a.job_id);
    RETURN true;
END
$$;

-- ------------------------------------------------------------------- grants

GRANT EXECUTE ON FUNCTION create_area(jsonb, int, text),
    set_area_detail(uuid, int), delete_area(uuid), reset_atom(bigint)
TO player, admin;

CREATE FUNCTION api.create_area(geojson jsonb, detail int DEFAULT 0,
                                name text DEFAULT '') RETURNS uuid
LANGUAGE sql AS $$SELECT public.create_area(geojson, detail, name)$$;

CREATE FUNCTION api.set_area_detail(area_id uuid, detail int) RETURNS int
LANGUAGE sql AS $$SELECT public.set_area_detail(area_id, detail)$$;

CREATE FUNCTION api.delete_area(area_id uuid) RETURNS void
LANGUAGE sql AS $$SELECT public.delete_area(area_id)$$;

CREATE FUNCTION api.reset_atom(atom_id bigint) RETURNS boolean
LANGUAGE sql AS $$SELECT public.reset_atom(atom_id)$$;

GRANT EXECUTE ON FUNCTION api.create_area(jsonb, int, text),
    api.set_area_detail(uuid, int), api.delete_area(uuid), api.reset_atom(bigint)
TO player, admin;
