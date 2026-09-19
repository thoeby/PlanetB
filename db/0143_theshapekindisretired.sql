-- 0143_theshapekindisretired.sql — the shape kind goes quiet.
--
-- TASKS-foundation.md FND.11. db/0142 turns every `terrainmod` polygon into
-- the grid of relative metres a land carries since FND.9. When the last one is
-- converted there is nothing left for the kind to be, and this is how it
-- stops being offered: not a DROP, because the shapes that were are still
-- rows pointing at it and this world removes nothing (Invariant 1), but a
-- kind with no geometry — "null for things that are not drawn at all"
-- (db/0040). gis_layers() and the views QGIS connects to are built from the
-- kinds that have one, so the next project has no "Terrain edit" layer in it.
--
-- The symbol goes with it, and a symbol reaches the world exactly one way
-- (FND.8): by being pinned in a style_version. Turning it off without pinning
-- would move every tile's snapshot behind the operator's back and leave the
-- jobs in flight unable to publish (Invariant 2), so this pins and moves them
-- the way apply_styles does.

CREATE FUNCTION retire_shape_kind() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    over int;
    sid  int;
    t    record;
    jid  bigint;
    n    int := 0;
BEGIN
    PERFORM require_admin();
    SELECT count(*) INTO over FROM feature
    WHERE kind = 'terrainmod' AND deleted_at IS NULL;
    IF over > 0 THEN
        RAISE EXCEPTION 'there are still % terrain edit(s) to convert', over
            USING errcode = 'PT409';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM kind WHERE name = 'terrainmod'
                     AND geometry IS NOT NULL) THEN
        RETURN jsonb_build_object('retired', false, 'tiles', 0);
    END IF;

    UPDATE kind SET geometry = null WHERE name = 'terrainmod';
    UPDATE symbol SET enabled = false, updated_at = now()
    WHERE kind = 'terrainmod' AND enabled;

    INSERT INTO style_version (symbols, note, applied_by)
    SELECT coalesce(jsonb_object_agg(s.id::text, s.version), '{}'::jsonb),
        'the terrain-edit kind is retired', current_user_id()
    FROM symbol s WHERE s.enabled
    RETURNING id INTO sid;

    -- The union is read whole before the first tile moves, and the job is
    -- asked for before it is named: the same two reasons as db/0140.
    PERFORM set_config('splatworld.rebuild', '1', true);
    FOR t IN
        WITH inflight AS MATERIALIZED (
            SELECT j.z::int AS z, j.x, j.y FROM job j
            INNER JOIN tile ti ON ti.z = j.z AND ti.x = j.x AND ti.y = j.y
            WHERE j.state = 'open' AND j.target_version = ti.expected_version)
        SELECT z, x, y FROM inflight
    LOOP
        UPDATE tile SET dirty = true, expected_version = expected_version + 1
        WHERE tile.z = t.z AND tile.x = t.x AND tile.y = t.y;
        jid := ensure_job(t.z, t.x, t.y);
        UPDATE job SET reason = 'style update' WHERE id = jid;
        n := n + 1;
    END LOOP;
    PERFORM set_config('splatworld.rebuild', '', true);

    RETURN jsonb_build_object('retired', true, 'style_version', sid, 'tiles', n);
END
$$;
GRANT EXECUTE ON FUNCTION retire_shape_kind() TO admin;

CREATE FUNCTION api.retire_shape_kind() RETURNS jsonb
LANGUAGE sql VOLATILE AS $$SELECT public.retire_shape_kind()$$;
GRANT EXECUTE ON FUNCTION api.retire_shape_kind() TO admin;
