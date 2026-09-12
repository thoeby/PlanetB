-- 0047_landisground.sql — land is ground, with or without anything on it.
--
-- A tile existed only where something stood: `mark_tiles_dirty` fires on
-- feature and instance, and drawing an area made no tile at all. So somebody
-- draws their land, presses Submit, and is told nothing has changed — while the
-- world stays black over ground the coverage has had all along.
--
-- The ground is the world's first fact (T0, T1): the DEM under an area is a
-- tile whether or not a road crosses it. Claiming ground is therefore itself a
-- change, and the tiles that cover it are dirty from that moment.
--
-- Invariant 4 holds: this only marks dirty and bumps expected_version, exactly
-- as db/0010_lockorder.sql's trigger does, coarse before fine.

CREATE FUNCTION area_ground_dirty() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    g     geometry;
    depth int;
BEGIN
    IF tg_op = 'UPDATE' THEN
        -- A moved boundary leaves ground behind and takes ground on.
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

CREATE TRIGGER area_ground_dirty
AFTER INSERT OR UPDATE OF geom, detail ON area
FOR EACH ROW EXECUTE FUNCTION area_ground_dirty();

-- The land already drawn, which was drawn before this was true.
INSERT INTO tile (z, x, y, dirty, expected_version)
SELECT t.z, t.x, t.y, true, 1
FROM area a, LATERAL tiles_for_geom(a.geom, 6, a.detail) AS t
ORDER BY t.z, t.x, t.y
ON CONFLICT (z, x, y) DO NOTHING;
