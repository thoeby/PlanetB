-- 0089_finetileswheretheyareearned.sql — a tile is made as fine as what stands
-- on it, not as fine as the land's ceiling.
--
-- `area.detail` was a quota: every path that built tiles did
-- `tiles_for_geom(a.geom, 6, a.detail)`, a row for every tile from z6 down to
-- the ceiling across the whole land, whatever was on it. At detail 18 that is
-- ninety tiles a square kilometre, and each one is a GPU training job — 120
-- rendered views, 7000 iterations, two million splats — spent re-deriving a
-- surface the elevation model already describes exactly. A lake drawn at
-- detail 18 asked for hundreds of them.
--
-- Worse, none of it could be seen. client/js/traverse.js refines a tile into
-- its children only when every child the world has a row for is published, so
-- z16 appears only once all sixteen under its z14 parent are done and z18 once
-- all sixteen under its z16 — 256 trained tiles before anything finer than z14
-- is ever drawn.
--
-- So the ceiling becomes a ceiling and the depth is earned:
--
--     z6 … z14   every tile of the land
--     z16        where something drawn or placed stands
--     z18        where something with fine structure stands — a footprint, or
--                anything put down from the catalog
--
-- z14 is the floor because it is what the design already calls the baseline
-- ("14 — 1.7 km tiles, the baseline", client/js/landfine.js) and because it is
-- the last rung that is sampled rather than trained: it costs a tab some
-- arithmetic and no GPU at all. Everything above it is a training job, and
-- that is what has to be earned.
--
-- What is fine is a property of the kind (`kind.fine`), because what the world
-- may hold is a table and not a list in code (db/0040_properties.sql): water,
-- forest and a road are shapes on the ground and stop at z16; a footprint has
-- walls you walk up to.
--
-- THE ONE RULE THIS MUST NOT BREAK: a parent is replaced by its children when
-- it refines, so a parent with only some of its children tears a hole in the
-- ground. Checked against the traversal: four of sixteen children present and
-- published drew four z16 and no z14 — three quarters of that tile gone. The
-- depth is therefore decided per parent and every child of a descending parent
-- is made, so the set is always whole inside the land. At the land's edge it is
-- ragged, as it always was, and outside it there is no compiled ground to hole.

ALTER TABLE kind ADD COLUMN fine boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN kind.fine IS
    'Whether a thing of this kind earns the finest tiles (z18). A shape on the '
    'ground does not; something with walls or edges you walk up to does.';

UPDATE kind SET fine = true WHERE name IN ('footprint');

-- Everything standing on a piece of land, and whether it earns the finest
-- tiles. Anything put down from the catalog does; a drawn shape does if its
-- kind says so.
CREATE FUNCTION area_things(p_area uuid)
RETURNS TABLE (geom geometry, fine boolean)
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT f.geom, coalesce(k.fine, false)
FROM feature f LEFT JOIN kind k ON k.name = f.kind
WHERE f.area_id = p_area AND f.deleted_at IS null
UNION ALL
SELECT i.geom, true FROM instance i
WHERE i.area_id = p_area AND i.deleted_at IS null;
$$;

-- Whether this tile's block is worth splitting into its sixteen children.
CREATE FUNCTION tile_earns_finer(a_z int, a_x int, a_y int, p_area uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT CASE
    -- The ladder every piece of land has, whatever is on it. Sampled, not
    -- trained: no tab needs a GPU for any of it.
    WHEN a_z < 14 THEN true
    -- Something actually standing on it earns the first trained rung.
    WHEN a_z = 14 THEN EXISTS (
        SELECT 1 FROM area_things(p_area) t
        WHERE st_intersects(t.geom, tile_bbox(a_z, a_x, a_y)))
    -- And something with structure worth walking up to earns the last.
    WHEN a_z = 16 THEN EXISTS (
        SELECT 1 FROM area_things(p_area) t
        WHERE t.fine AND st_intersects(t.geom, tile_bbox(a_z, a_x, a_y)))
    ELSE false
END;
$$;

-- The tiles a piece of land is made of: the ladder, deepened where it is
-- earned, and whole at every level so nothing is ever half-refined.
CREATE FUNCTION area_tiles(p_area uuid)
RETURNS TABLE (z int, x int, y int)
LANGUAGE sql STABLE SET search_path = public AS $$
WITH RECURSIVE walk AS (
    SELECT t.z::int, t.x::int, t.y::int
    FROM area a, LATERAL tiles_for_geom(a.geom, 6, 6) t
    WHERE a.id = p_area
    UNION ALL
    SELECT w.z + 2, cx::int, cy::int
    FROM walk w
    INNER JOIN area a ON a.id = p_area,
    LATERAL generate_series(w.x * 4, w.x * 4 + 3) cx,
    LATERAL generate_series(w.y * 4, w.y * 4 + 3) cy
    WHERE w.z + 2 <= a.detail
      AND tile_earns_finer(w.z::int, w.x::int, w.y::int, p_area)
      AND st_intersects(a.geom, tile_bbox(w.z + 2, cx::int, cy::int))
)
SELECT walk.z, walk.x, walk.y FROM walk;
$$;

GRANT EXECUTE ON FUNCTION area_things(uuid),
    tile_earns_finer(int, int, int, uuid), area_tiles(uuid)
TO anon, player, admin;

-- ------------------------------------------------- and everything that builds

-- Five places made a land's tiles and each one asked for the whole ladder to
-- the ceiling. They all ask area_tiles() now, which is the same set with the
-- depth earned. None of them changes in any other way.

-- db/0004_tiles.sql's mark_tiles_dirty. Drawing a building is what earns the
-- fine tiles under it, so this makes the land's tiles as well as dirtying them,
-- and it has to cover three cases rather than one:
--
--   * a tile the land has just earned has never been built, so it is dirty
--     whether or not the thing that earned it stands on that particular tile —
--     a block of sixteen is made whole or it is a hole, and a tile nobody
--     marked would never be submitted;
--   * a tile that was already there and is under the change is dirty, as it
--     always was;
--   * a tile that exists and is no longer earned — the last building on it was
--     deleted — is dirty too, because what is compiled into it still has the
--     building in it. Dropping the row is not the answer: it may be published,
--     and an artifact is never unmade (Invariant 1).
CREATE OR REPLACE FUNCTION mark_tiles_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    row_area_id uuid;
    g           geometry;
    land        geometry;
BEGIN
    IF tg_op = 'INSERT' THEN
        row_area_id := new.area_id;
        g := new.geom;
    ELSIF tg_op = 'DELETE' THEN
        row_area_id := old.area_id;
        g := old.geom;
    ELSE
        row_area_id := new.area_id;
        g := st_collect(old.geom, new.geom);
    END IF;
    SELECT a.geom INTO land FROM area a WHERE a.id = row_area_id;

    -- Coarse before fine (db/0010_lockorder.sql).
    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT t.z, t.x, t.y, true, 1
    FROM (
        SELECT at.z, at.x, at.y FROM area_tiles(row_area_id) at
        UNION
        SELECT old_t.z, old_t.x, old_t.y FROM tile old_t
        WHERE st_intersects(g, tile_bbox(old_t.z, old_t.x, old_t.y))
          AND st_intersects(land, tile_bbox(old_t.z, old_t.x, old_t.y))
    ) t
    ORDER BY t.z, t.x, t.y
    ON CONFLICT (z, x, y) DO UPDATE
    -- Already there: only the ones the change actually touches move.
    SET dirty = tile.dirty OR st_intersects(g, tile_bbox(tile.z, tile.x, tile.y)),
        expected_version = tile.expected_version
            + CASE WHEN st_intersects(g, tile_bbox(tile.z, tile.x, tile.y))
                   THEN 1 ELSE 0 END;

    RETURN NULL;
END
$$;

-- db/0064_claimingrendersnothing.sql's area_ground_dirty.
CREATE OR REPLACE FUNCTION area_ground_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF tg_op = 'UPDATE' THEN
        -- A moved boundary leaves ground behind and takes ground on. What was
        -- compiled there was compiled from the old boundary, so those tiles
        -- are out of date.
        INSERT INTO tile (z, x, y, dirty, expected_version)
        SELECT t.z, t.x, t.y, true, 1
        FROM tiles_for_geom(st_collect(old.geom, new.geom), 6,
                            least(greatest(old.detail, new.detail), 14)) AS t
        ORDER BY t.z, t.x, t.y
        ON CONFLICT (z, x, y) DO UPDATE
        SET dirty = true, expected_version = tile.expected_version + 1;
        INSERT INTO tile (z, x, y, dirty, expected_version)
        SELECT t.z, t.x, t.y, true, 1 FROM area_tiles(new.id) AS t
        ORDER BY t.z, t.x, t.y
        ON CONFLICT (z, x, y) DO UPDATE
        SET dirty = true, expected_version = tile.expected_version + 1;
        RETURN NULL;
    END IF;

    -- A new piece of land: the tiles that cover it exist, so the panel can
    -- count them and a compile has something to attach to, and none of them
    -- is waiting for anything (db/0064).
    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT t.z, t.x, t.y, false, 1 FROM area_tiles(new.id) AS t
    ORDER BY t.z, t.x, t.y
    ON CONFLICT (z, x, y) DO NOTHING;
    RETURN NULL;
END
$$;

-- db/0084_buildingitagainclearswhatitreplaces.sql's two.
CREATE OR REPLACE FUNCTION recompile_land(p_area uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    a area%rowtype;
    n int := 0;
BEGIN
    SELECT * INTO a FROM area WHERE area.id = p_area;
    IF a.id IS null THEN
        RAISE EXCEPTION 'no such area %', p_area USING errcode = '23503';
    END IF;
    IF NOT (is_area_owner(p_area) OR current_user_role() = 'admin') THEN
        RAISE EXCEPTION 'that is not your land to compile' USING errcode = '42501';
    END IF;

    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT t.z, t.x, t.y, true, 1 FROM area_tiles(p_area) AS t
    ORDER BY t.z, t.x, t.y
    ON CONFLICT (z, x, y) DO UPDATE
    SET dirty = true, expected_version = tile.expected_version + 1;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM supersede_jobs(a.geom);
    RETURN n;
END
$$;

CREATE OR REPLACE FUNCTION set_area_detail(p_area uuid, p_detail int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a area%rowtype;
    n int := 0;
BEGIN
    SELECT * INTO a FROM area WHERE area.id = p_area FOR UPDATE;
    IF a.id IS null THEN
        RAISE EXCEPTION 'no such area %', p_area;
    END IF;
    IF NOT is_area_owner(p_area) THEN
        RAISE EXCEPTION 'not your area' USING errcode = '42501';
    END IF;
    UPDATE area SET detail = p_detail WHERE area.id = p_area;
    IF p_detail > a.detail THEN
        INSERT INTO tile (z, x, y, dirty, expected_version)
        SELECT t.z, t.x, t.y, true, 1 FROM area_tiles(p_area) AS t
        ORDER BY t.z, t.x, t.y
        ON CONFLICT (z, x, y) DO UPDATE
        SET dirty = true, expected_version = tile.expected_version + 1;
        GET DIAGNOSTICS n = ROW_COUNT;
        PERFORM supersede_jobs(a.geom);
    END IF;
    RETURN n;
END
$$;

-- db/0085_landanadmincantakeback.sql's delete_area, which marks the ground it
-- covered. It reads the land's tiles before the land is gone.
CREATE OR REPLACE FUNCTION delete_area(p_area uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    a     area%rowtype;
    tiles int := 0;
    jobs  int := 0;
    name  text;
BEGIN
    IF current_user_role() <> 'admin' THEN
        RAISE EXCEPTION 'only an admin may delete land' USING errcode = '42501';
    END IF;
    SELECT * INTO a FROM area WHERE area.id = p_area FOR UPDATE;
    IF a.id IS null THEN
        RAISE EXCEPTION 'no such land %', p_area USING errcode = '23503';
    END IF;
    name := coalesce(nullif(a.rules ->> 'name', ''), 'that land');

    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT t.z, t.x, t.y, true, 1 FROM area_tiles(p_area) AS t
    ORDER BY t.z, t.x, t.y
    ON CONFLICT (z, x, y) DO UPDATE
    SET dirty = true, expected_version = tile.expected_version + 1;
    GET DIAGNOSTICS tiles = ROW_COUNT;
    jobs := supersede_jobs(a.geom);

    DELETE FROM proposal WHERE area_id = p_area;
    DELETE FROM instance WHERE area_id = p_area;
    DELETE FROM feature WHERE area_id = p_area;
    DELETE FROM area WHERE id = p_area;

    RETURN jsonb_build_object('name', name, 'tiles', tiles, 'jobs', jobs);
END
$$;
