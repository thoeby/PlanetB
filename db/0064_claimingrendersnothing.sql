-- 0064_claimingrendersnothing.sql — land you have just been given is ground.
--
-- SPEC §3.2, post: "its fine tiles are `ground` (not `changed` — claiming land
-- renders nothing)". db/0047_landisground.sql made claiming ground a change,
-- for a reason that has since stopped being true: the viewer had no floor
-- except published tiles, so land nobody had compiled was black, and dirtying
-- its tiles was how it got drawn at all.
--
-- The viewer now draws the DEM everywhere the coverage reaches
-- (client/lib/groundmesh.js, SPEC §0.1), so ground is visible without anybody
-- compiling anything. A new piece of land therefore has tiles — they are the
-- compile units, and Your land counts them — and nothing waiting on them
-- until something is drawn or placed there.
--
-- Invariant 4 still holds: this trigger only ever touched `dirty`, and now
-- touches less.

-- SECURITY DEFINER, as db/0048_groundowner.sql made it: what the tile table
-- records is the schema's own bookkeeping, not the writer's, and the role QGIS
-- draws as may read tiles and not write them.
CREATE OR REPLACE FUNCTION area_ground_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    g     geometry;
    depth int;
BEGIN
    IF tg_op = 'UPDATE' THEN
        -- A moved boundary leaves ground behind and takes ground on. What was
        -- compiled there was compiled from the old boundary, so those tiles
        -- are out of date; a boundary that has never moved has nothing to
        -- redo.
        g := st_collect(old.geom, new.geom);
        depth := greatest(old.detail, new.detail);
        INSERT INTO tile (z, x, y, dirty, expected_version)
        SELECT t.z, t.x, t.y, true, 1 FROM tiles_for_geom(g, 6, depth) AS t
        ORDER BY t.z, t.x, t.y
        ON CONFLICT (z, x, y) DO UPDATE
        SET dirty = true, expected_version = tile.expected_version + 1;
        RETURN NULL;
    END IF;

    -- A new piece of land: the tiles that cover it exist, so the panel can
    -- count them and a compile has something to attach to, and none of them
    -- is waiting for anything.
    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT t.z, t.x, t.y, false, 1 FROM tiles_for_geom(new.geom, 6, new.detail) AS t
    ORDER BY t.z, t.x, t.y
    ON CONFLICT (z, x, y) DO NOTHING;
    RETURN NULL;
END
$$;
