-- 0054_drawyourland.sql — "Your land" is a layer you can actually draw on.
--
-- gis.area is `SELECT id, geom, detail FROM area` and nothing else: no INSTEAD
-- OF trigger, unlike every f_* layer (0041). Two consequences, and the first
-- hides the second.
--
-- GeoServer serves it read-only —
--
--     {http://splatworld}area is read-only
--
-- and even if it did not, area.owner_id is NOT NULL and is not a column of the
-- view. db/0028 put a default on the view's owner_id; db/0031 rebuilt the view
-- without that column, and the default went with it. So an insert through this
-- layer has been impossible since then, in two independent ways.
--
-- A third: the view inherits the table's geometry(Polygon, 4326), and QGIS
-- draws multipart, so the polygon was refused by the column type before any
-- trigger could have run. The layer is MultiPolygon on the wire, as every f_*
-- layer already is, and the trigger puts the single part back in the table.
--
-- The same shape as the drawn layers: a trigger that writes the table, filling
-- in what a drawer does not type. Invariant 9 holds — GeoServer is the admin
-- path, and this decides nothing about the world beyond who owns new ground.

-- Note on where lon/lat is enforced for an area: area.geom is
-- geometry(Polygon, 4326), and a typmod is checked as the value is assigned to
-- the column — before any BEFORE trigger runs. So db/0053's approach, which
-- works for feature.geom (plain geometry with a CHECK constraint), cannot work
-- here. The conversion happens in the trigger below instead, which runs before
-- the table is touched at all. The view's own 4326 typmod is what GeoServer
-- sends against, and it declares the layer 4326 (FORCE_DECLARED).

DROP VIEW IF EXISTS gis.area CASCADE;
CREATE VIEW gis.area AS
SELECT id, st_multi(geom)::geometry(MultiPolygon, 4326) AS geom, detail FROM area;

CREATE FUNCTION gis_area_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, gis AS $$
DECLARE
    g   geometry;
    row_id uuid;
BEGIN
    IF tg_op = 'DELETE' THEN
        DELETE FROM area WHERE area.id = old.id;
        RETURN old;
    END IF;
    -- area.geom is a Polygon. QGIS draws multipart by default, and a one-part
    -- multipolygon is the same ground under another name.
    g := st_force2d(as_lonlat(new.geom));
    IF st_geometrytype(g) = 'ST_MultiPolygon' AND st_numgeometries(g) = 1 THEN
        g := st_geometryn(g, 1);
    END IF;

    IF tg_op = 'INSERT' THEN
        INSERT INTO area (id, geom, owner_id, detail)
        VALUES (coalesce(new.id, gen_random_uuid()), g,
                gis.default_owner(),
                coalesce(new.detail, 14))
        RETURNING area.id INTO row_id;
        new.id := row_id;
        RETURN new;
    END IF;
    UPDATE area SET geom = g, detail = coalesce(new.detail, area.detail)
    WHERE area.id = old.id;
    RETURN new;
END;
$$;

CREATE TRIGGER gis_area_write INSTEAD OF INSERT OR UPDATE OR DELETE ON gis.area
FOR EACH ROW EXECUTE FUNCTION gis_area_write();

GRANT SELECT, INSERT, UPDATE, DELETE ON gis.area TO geoserver;
