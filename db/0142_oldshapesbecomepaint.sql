-- 0142_oldshapesbecomepaint.sql — the shapes that used to move the ground.
--
-- TASKS-foundation.md FND.11. Before FND.9 the only way to move the ground was
-- to draw a `terrainmod` polygon and let the compiler flatten, raise, lower or
-- smooth whatever fell inside it. A land carries a grid of relative metres now
-- (db/0141), and two ways of saying the same thing is one too many: what a
-- terrainmod did to the ground is exactly what a few strokes of the grid do.
--
-- So they are converted, once, and the kind is retired behind them
-- (db/0143). The conversion is a tab's work like every other (Invariant 9):
-- this only says which lands are left to do and lets the operator do them.

-- The shapes that are left, and the lands they are on — each land as the
-- panels already read one (db/0067's area_view), because the tab that converts
-- them shapes the ground with it and needs its outline and its box.
-- SET search_path: PostgREST calls this with `api` ahead of `public`, where
-- `area` is the view and not the table, and `area_view` takes the table's row
-- type. `my_areas` (db/0021) is qualified for the same reason.
CREATE FUNCTION old_shapes() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT jsonb_build_object(
    'shapes', (SELECT count(*) FROM feature f
               WHERE f.kind = 'terrainmod' AND f.deleted_at IS NULL),
    'lands', coalesce((
        SELECT jsonb_agg(public.area_view(a) || jsonb_build_object('shapes', n.shapes)
            ORDER BY a.created_at)
        FROM (SELECT f.area_id AS id, count(*) AS shapes
              FROM feature f
              WHERE f.kind = 'terrainmod' AND f.deleted_at IS NULL
              GROUP BY f.area_id) n
        INNER JOIN area a ON a.id = n.id), '[]'::jsonb));
$$;
GRANT EXECUTE ON FUNCTION old_shapes() TO anon, player, admin;

CREATE FUNCTION api.old_shapes() RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.old_shapes()$$;
GRANT EXECUTE ON FUNCTION api.old_shapes() TO anon, player, admin;

-- The shapes on one land, as the tab that converts them reads them: the
-- outline and what the shape said to do, in GeoJSON like everything else a
-- tab is handed (tile_world).
CREATE FUNCTION area_shapes(p_area uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id, 'props', f.props,
    'geom', st_asgeojson(f.geom, 12)::jsonb) ORDER BY f.id), '[]'::jsonb)
FROM feature f
WHERE f.area_id = p_area AND f.kind = 'terrainmod' AND f.deleted_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION area_shapes(uuid) TO anon, player, admin;

CREATE FUNCTION api.area_shapes(area uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$SELECT public.area_shapes(area)$$;
GRANT EXECUTE ON FUNCTION api.area_shapes(uuid) TO anon, player, admin;

-- ------------------------------------------------------- who may shape it

-- Invariant 6: shaping a land is the landholder's, and db/0141 said so in one
-- place. The conversion is the one thing that is not theirs — it is the
-- operator clearing a vocabulary they never chose, on every land at once — so
-- the operator may shape any land too. For a player nothing changes, including
-- the sentence they are refused with.
CREATE FUNCTION may_shape(p_area uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT is_area_proposer(p_area) OR current_user_role() = 'admin';
$$;
GRANT EXECUTE ON FUNCTION may_shape(uuid) TO anon, player, admin;

-- db/0141's save_height_edit, with that one line where the guard was.
CREATE OR REPLACE FUNCTION save_height_edit(p_area uuid, p_sha text, p_rev bigint,
                                            p_bbox jsonb DEFAULT null) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    uid  uuid := current_user_id();
    now_ bigint;
    box  geometry;
    hit  int := 0;
    dep  smallint;
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'authentication required' USING errcode = 'PT401';
    END IF;
    IF NOT may_shape(p_area) THEN
        RAISE EXCEPTION 'you can only shape your own land' USING errcode = 'PT403';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM artifact a WHERE a.sha256 = p_sha
                     AND a.kind = 'height_edit') THEN
        RAISE EXCEPTION 'no height_edit artifact %', p_sha USING errcode = 'PT404';
    END IF;
    SELECT coalesce(max(rev), 0) INTO now_ FROM height_edit WHERE area_id = p_area;
    IF coalesce(p_rev, 0) <> now_ THEN
        RAISE EXCEPTION 'this ground was shaped in another tab — reload it'
            USING errcode = 'PT409';
    END IF;

    INSERT INTO height_edit (area_id, sha256, rev, saved_by)
    VALUES (p_area, p_sha, now_ + 1, uid);

    SELECT detail INTO dep FROM area WHERE id = p_area;
    SELECT st_intersection(a.geom, CASE WHEN p_bbox IS NULL THEN a.geom ELSE
        st_setsrid(st_makeenvelope(
            (p_bbox ->> 0)::double precision, (p_bbox ->> 1)::double precision,
            (p_bbox ->> 2)::double precision, (p_bbox ->> 3)::double precision),
            world_srid()) END)
    INTO box FROM area a WHERE a.id = p_area;

    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT t.z, t.x, t.y, true, 1 FROM tiles_for_geom(box, 6, dep) AS t
    ORDER BY t.z, t.x, t.y
    ON CONFLICT (z, x, y) DO UPDATE
    SET dirty = true, expected_version = tile.expected_version + 1;
    GET DIAGNOSTICS hit = ROW_COUNT;

    RETURN jsonb_build_object('rev', now_ + 1, 'tiles', hit);
END
$$;

-- Retiring the shapes on one land: the grid has been saved, and these say the
-- same thing twice. Soft-deleted, because nothing in this world is removed —
-- and by the same rule that decides who may shape the ground (Invariant 6).
CREATE FUNCTION retire_shapes(p_area uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    n int;
BEGIN
    IF NOT may_shape(p_area) THEN
        RAISE EXCEPTION 'you can only shape your own land' USING errcode = 'PT403';
    END IF;
    UPDATE feature SET deleted_at = now()
    WHERE area_id = p_area AND kind = 'terrainmod' AND deleted_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END
$$;
GRANT EXECUTE ON FUNCTION retire_shapes(uuid) TO player, admin;

CREATE FUNCTION api.retire_shapes(area uuid) RETURNS int
LANGUAGE sql VOLATILE AS $$SELECT public.retire_shapes(area)$$;
GRANT EXECUTE ON FUNCTION api.retire_shapes(uuid) TO player, admin;
