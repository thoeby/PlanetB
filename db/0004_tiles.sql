-- 0004_tiles.sql — Web-Mercator tile maths and the only trigger that touches
-- tiles. Invariant 4: it marks dirty and bumps expected_version, nothing else.
-- No job, no atom, no compute is created here.

CREATE FUNCTION tile_x(lon double precision, z int) RETURNS int
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT least(greatest(floor((lon + 180) / 360 * (1 << z))::int, 0), (1 << z) - 1);
$$;

CREATE FUNCTION tile_y(lat double precision, z int) RETURNS int
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT least(greatest(floor(
    (1 - asinh(tan(radians(
        least(greatest(lat, -85.0511287798066), 85.0511287798066))
    )) / pi()) / 2 * (1 << z))::int, 0), (1 << z) - 1);
$$;

CREATE FUNCTION tile_bbox(z int, x int, y int) RETURNS geometry
LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT st_makeenvelope(
    x::double precision / (1 << z) * 360 - 180,
    degrees(atan(sinh(pi() * (1 - 2 * (y + 1)::double precision / (1 << z))))),
    (x + 1)::double precision / (1 << z) * 360 - 180,
    degrees(atan(sinh(pi() * (1 - 2 * y::double precision / (1 << z))))),
    4326);
$$;

-- Every even zoom between min_z and max_z whose tile intersects g.
-- Mirrored bit-for-bit by client/lib/tilemath.js (WP1.1).
CREATE FUNCTION tiles_for_geom(g geometry, min_z int, max_z int)
RETURNS TABLE (z smallint, x int, y int)
LANGUAGE sql STABLE AS $$
WITH e AS (
    SELECT st_xmin(b) AS x0, st_ymin(b) AS y0,
           st_xmax(b) AS x1, st_ymax(b) AS y1
    FROM (SELECT st_envelope(g) AS b) env
)
SELECT zz::smallint, xi, yi
FROM generate_series(min_z, max_z, 2) AS zz, e,
    generate_series(tile_x(e.x0, zz), tile_x(e.x1, zz)) AS xi,
    generate_series(tile_y(e.y1, zz), tile_y(e.y0, zz)) AS yi
WHERE st_intersects(g, tile_bbox(zz, xi, yi));
$$;

GRANT EXECUTE ON FUNCTION tile_x(double precision, int),
    tile_y(double precision, int), tile_bbox(int, int, int),
    tiles_for_geom(geometry, int, int)
TO anon, player, admin;

-- ----------------------------------------------------------------- versioning

CREATE FUNCTION bump_rev() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    a area%rowtype;
BEGIN
    SELECT * INTO a FROM area WHERE area.id = new.area_id;
    IF NOT st_intersects(new.geom, a.geom) THEN
        RAISE EXCEPTION 'geometry lies outside area %', new.area_id;
    END IF;
    IF tg_op = 'UPDATE' THEN
        new.rev := old.rev + 1;
    END IF;
    RETURN new;
END
$$;

-- SECURITY DEFINER: players may edit the world but hold no grant on tile;
-- the dirty mark is the database's own bookkeeping, not a client write.
CREATE FUNCTION mark_tiles_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    row_area_id uuid;
    depth       smallint;
    g           geometry;
BEGIN
    -- A move dirties where the row was and where it now is.
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
    SELECT detail INTO depth FROM area WHERE id = row_area_id;

    INSERT INTO tile (z, x, y, dirty, expected_version)
    SELECT t.z, t.x, t.y, true, 1 FROM tiles_for_geom(g, 6, depth) AS t
    ON CONFLICT (z, x, y) DO UPDATE
    SET dirty = true, expected_version = tile.expected_version + 1;

    RETURN NULL;
END
$$;

CREATE TRIGGER feature_bump_rev BEFORE INSERT OR UPDATE ON feature
FOR EACH ROW EXECUTE FUNCTION bump_rev();
CREATE TRIGGER feature_dirty AFTER INSERT OR UPDATE OR DELETE ON feature
FOR EACH ROW EXECUTE FUNCTION mark_tiles_dirty();

CREATE TRIGGER instance_bump_rev BEFORE INSERT OR UPDATE ON instance
FOR EACH ROW EXECUTE FUNCTION bump_rev();
CREATE TRIGGER instance_dirty AFTER INSERT OR UPDATE OR DELETE ON instance
FOR EACH ROW EXECUTE FUNCTION mark_tiles_dirty();
