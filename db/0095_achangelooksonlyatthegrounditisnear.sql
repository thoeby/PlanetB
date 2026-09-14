-- 0095_achangelooksonlyatthegrounditisnear.sql — drawing one building reads
-- the tiles under that building, not every tile of the land.
--
-- db/0089 gave mark_tiles_dirty() the land's whole ladder to ask for, through
-- area_tiles(). mark_tiles_dirty is FOR EACH ROW (db/0004_tiles.sql), so a
-- statement that puts five hundred things on a piece of land walked the whole
-- land five hundred times, and each walk asked tile_earns_finer() of every
-- tile on the way down. db/test/0006_concurrency.sh seeds exactly that — one
-- footprint per z14 tile of a 1.2° × 0.9° area — and it stopped coming back:
-- twenty minutes in, still inside the one INSERT.
--
-- Two things were wrong and both are arithmetic, not rules. The tiles this
-- change earns are the ones near it, so the walk is pruned to the change: a
-- parent is descended into only where the change touches it. And
-- tile_earns_finer() asked area_things(), a function whose rows come back with
-- no index on them, so every tile on the way down compared itself against
-- everything on the land; asked of the tables directly it is a GiST probe
-- (feature_geom_idx, instance_geom_idx, db/0001_schema.sql).
--
-- The rule db/0089 set down is unchanged, and so is the one it must not break:
-- a parent that descends emits all sixteen of its children, so a block is
-- whole or it is absent. Pruning removes whole subtrees the change is nowhere
-- near, never part of a block.

-- Asked of the tables, so the spatial indexes are usable. area_things() stays
-- as it is: it is the readable answer to "what stands here", and nothing on a
-- hot path asks it any more.
CREATE OR REPLACE FUNCTION tile_earns_finer(a_z int, a_x int, a_y int, p_area uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
SELECT CASE
    WHEN a_z < 14 THEN true
    WHEN a_z = 14 THEN EXISTS (
        SELECT 1 FROM feature f
        WHERE f.area_id = p_area AND f.deleted_at IS null
          AND st_intersects(f.geom, tile_bbox(a_z, a_x, a_y))
        UNION ALL
        SELECT 1 FROM instance i
        WHERE i.area_id = p_area AND i.deleted_at IS null
          AND st_intersects(i.geom, tile_bbox(a_z, a_x, a_y)))
    WHEN a_z = 16 THEN EXISTS (
        SELECT 1 FROM feature f INNER JOIN kind k ON k.name = f.kind
        WHERE f.area_id = p_area AND f.deleted_at IS null AND k.fine
          AND st_intersects(f.geom, tile_bbox(a_z, a_x, a_y))
        UNION ALL
        SELECT 1 FROM instance i
        WHERE i.area_id = p_area AND i.deleted_at IS null
          AND st_intersects(i.geom, tile_bbox(a_z, a_x, a_y)))
    ELSE false
END;
$$;

-- The tiles a change to this geometry earns, and the whole blocks they sit in.
-- The same set area_tiles() would give for the ground the change is on, and
-- always a subset of it.
--
-- Not a recursive walk. area_tiles() descends because it has the whole land to
-- cover; a change is a small thing, and the tiles over it at each level are
-- tiles_for_geom(p_geom, z, z) — arithmetic on the grid, no recursion at all.
-- Which is the same set the walk reaches, because the walk descends only into
-- a tile the change touches, and every tile the change touches at a level is
-- the child of the one it touches at the level above.
--
-- A parent that descends emits all sixteen of its children, so a block is
-- whole or absent — the rule db/0089 must not break. And a parent only has to
-- be asked about itself, never about its ancestors: a z16 tile earns the last
-- rung because something with walls stands on it, and that same thing stands
-- on its z14 parent, which is all the z14 rung asks for. The chain holds
-- itself up.
-- `SET jit = off`, and it is the difference between the gate running and the
-- gate hanging. This query touches about fifty rows, but the planner cannot
-- know that: tiles_for_geom() and generate_series() are guessed at a thousand
-- rows each and st_intersects() is priced at ten thousand, so the estimate
-- comes out at a hundred thousand rows and a cost of 1.4e9 — far over
-- jit_above_cost, and over the inlining and optimisation thresholds as well.
-- Every call then spent 214 ms in LLVM to run 3 ms of work, and a statement
-- that put five hundred things on a piece of land did it five hundred times.
-- Measured, on db/test/0006_concurrency.sh's fixture.
CREATE FUNCTION area_tiles_over(p_area uuid, p_geom geometry)
RETURNS TABLE (z int, x int, y int)
LANGUAGE sql STABLE SET search_path = public SET jit = off AS $$
-- UNION ALL, not UNION: the first branch is z6 and the second is z8 and
-- deeper, so there is nothing to deduplicate and the hash to do it with cost
-- more than the rows it looked at.
SELECT t.z::int, t.x, t.y
FROM area a, LATERAL tiles_for_geom(p_geom, 6, 6) t
WHERE a.id = p_area
  AND st_intersects(a.geom, tile_bbox(t.z::int, t.x, t.y))
UNION ALL
SELECT (p.z + 2)::int, cx::int, cy::int
FROM area a,
    LATERAL tiles_for_geom(p_geom, 6, greatest(a.detail - 2, 6)) p,
    LATERAL generate_series(p.x * 4, p.x * 4 + 3) cx,
    LATERAL generate_series(p.y * 4, p.y * 4 + 3) cy
WHERE a.id = p_area
  AND p.z + 2 <= a.detail
  AND tile_earns_finer(p.z::int, p.x, p.y, p_area)
  AND st_intersects(a.geom, tile_bbox((p.z + 2)::int, cx::int, cy::int));
$$;

GRANT EXECUTE ON FUNCTION area_tiles_over(uuid, geometry) TO anon, player, admin;

-- db/0089's mark_tiles_dirty, asking only about the ground the change is on.
-- Every other caller of area_tiles() is a whole-land operation — compile it
-- again, raise the ceiling, take the land away — and stays as it is.
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
        SELECT at.z, at.x, at.y FROM area_tiles_over(row_area_id, g) at
        UNION
        -- Tiles that are already there and are under the change: asked of
        -- the covering of the change and looked up by key, not by comparing
        -- every tile in the world against it once per row.
        SELECT old_t.z, old_t.x, old_t.y
        FROM tiles_for_geom(g, 6, 18) tg
        INNER JOIN tile old_t
            ON old_t.z = tg.z AND old_t.x = tg.x AND old_t.y = tg.y
        WHERE st_intersects(land, tile_bbox(old_t.z, old_t.x, old_t.y))
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

-- ------------------------------------------------- and the cost under all of it

-- tile_bbox() is the arithmetic everything on this page is made of, and since
-- db/0060_crssaysitonce.sql it ends `world_srid()` — which is find_srid(), a
-- query against public.geometry_columns, a view over six catalog tables. Half
-- a millisecond, on every tile of every walk. tile_bbox is declared IMMUTABLE
-- so the planner folds it away wherever its arguments are constants, and that
-- is why nothing noticed: inside a function, where the arguments come from
-- rows, it runs, and four hundred of them is two hundred milliseconds before
-- any of the work starts.
--
-- The world's SRID is decided by the schema and cannot change while the schema
-- stands, so it is read once, here, as this migration is applied, and said as
-- a constant thereafter. db/0056's rule holds — the CRS is still declared in
-- exactly one place, and that place is still this function — and tile_bbox is
-- now IMMUTABLE all the way down rather than in name only.
DO $do$
BEGIN
    EXECUTE format(
        $f$CREATE OR REPLACE FUNCTION world_srid() RETURNS int
           LANGUAGE sql IMMUTABLE PARALLEL SAFE AS 'SELECT %s'$f$,
        find_srid('public', 'area', 'geom'));
END
$do$;
