-- 0033_gisinstance.sql — placing a model in QGIS.
--
-- instance.geom is a generated column (from lon and lat), so a point drawn in
-- QGIS cannot be inserted into the table: "cannot insert a non-DEFAULT value
-- into column geom". The layer becomes a view of the columns a placer touches,
-- and INSTEAD OF triggers turn the point back into lon and lat. Blanks arrive
-- from GeoServer as 0 or '' (see 0030, 0032), and mean the default.

DROP VIEW gis.instance;
CREATE VIEW gis.instance AS
SELECT id, san, geom, h, yaw, pitch, roll, scale FROM instance WHERE deleted_at IS NULL;

CREATE FUNCTION gis_instance_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF tg_op = 'DELETE' THEN
        DELETE FROM instance WHERE id = old.id;
        RETURN old;
    END IF;
    IF coalesce(new.san, '') = '' THEN
        RAISE EXCEPTION 'san is empty — the catalog id of the model to place';
    END IF;
    IF tg_op = 'INSERT' THEN
        INSERT INTO instance (id, san, lon, lat, h, yaw, pitch, roll, scale)
        VALUES (coalesce(new.id, gen_random_uuid()), new.san,
                st_x(new.geom), st_y(new.geom),
                coalesce(new.h, 0), coalesce(new.yaw, 0), coalesce(new.pitch, 0),
                coalesce(new.roll, 0),
                CASE WHEN coalesce(new.scale, 0) = 0 THEN 1 ELSE new.scale END)
        RETURNING id INTO new.id;
        RETURN new;
    END IF;
    UPDATE instance SET
        san = new.san, lon = st_x(new.geom), lat = st_y(new.geom),
        h = coalesce(new.h, 0), yaw = coalesce(new.yaw, 0),
        pitch = coalesce(new.pitch, 0), roll = coalesce(new.roll, 0),
        scale = CASE WHEN coalesce(new.scale, 0) = 0 THEN 1 ELSE new.scale END
    WHERE id = old.id;
    RETURN new;
END;
$$;

CREATE TRIGGER gis_instance_write INSTEAD OF INSERT OR UPDATE OR DELETE ON gis.instance
FOR EACH ROW EXECUTE FUNCTION gis_instance_write();

GRANT SELECT, INSERT, UPDATE, DELETE ON gis.instance TO geoserver;
