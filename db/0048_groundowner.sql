-- 0048_groundowner.sql — the trigger that makes ground runs as the schema does.
--
-- db/0047_landisground.sql writes to `tile` when land is drawn, and it ran as
-- whoever was drawing: through QGIS that is the `geoserver` login, which may
-- read tiles and not write them. So drawing an area came back "keine
-- Berechtigung für Tabelle tile" — the one path this was built for.
--
-- mark_tiles_dirty has been SECURITY DEFINER since db/0004_tiles.sql for
-- exactly this reason: what the tile table records is the schema's own
-- bookkeeping, not the writer's. Invariant 6 is untouched — who may draw is
-- still decided by the policies on `area` and `feature`, and this function only
-- ever marks tiles dirty.
CREATE OR REPLACE FUNCTION area_ground_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    g     geometry;
    depth int;
BEGIN
    IF tg_op = 'UPDATE' THEN
        g := st_collect(old.geom, new.geom);
        depth := greatest(old.detail, new.detail);
    ELSE
        g := new.geom;
        depth := new.detail;
    END IF;

    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT t.z, t.x, t.y, true, 1 FROM tiles_for_geom(g, 6, depth) AS t
    ORDER BY t.z, t.x, t.y
    ON CONFLICT (z, x, y) DO UPDATE
    SET dirty = true, expected_version = tile.expected_version + 1;
    RETURN NULL;
END
$$;
