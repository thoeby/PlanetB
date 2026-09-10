-- 0034_giskinds.sql — one typed layer per feature kind, so QGIS can draw.
--
-- gis.feature carried an untyped geometry (a road is a line, a forest a
-- polygon), and GeoServer published it as gml:GeometryPropertyType — a layer
-- of unknown geometry type, which QGIS will show but not let anyone draw on
-- while it is empty. So one view per kind, each with the geometry cast to
-- what that kind is, and INSTEAD OF triggers to write through the cast.
-- A blank arrives from GeoServer as '' or 0 (0030, 0032); kind is the view's.

DROP VIEW gis.feature, gis.feature_road, gis.feature_forest, gis.feature_water,
    gis.feature_footprint, gis.feature_terrainmod;
DELETE FROM gis.gt_pk_metadata WHERE table_name = 'feature';

CREATE FUNCTION gis_feature_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    k text := tg_argv[0];
BEGIN
    IF tg_op = 'DELETE' THEN
        DELETE FROM feature WHERE id = old.id;
        RETURN old;
    END IF;
    IF tg_op = 'INSERT' THEN
        INSERT INTO feature (id, kind, geom)
        VALUES (coalesce(new.id, gen_random_uuid()), k, new.geom)
        RETURNING id INTO new.id;
        RETURN new;
    END IF;
    UPDATE feature SET geom = new.geom WHERE id = old.id;
    RETURN new;
END;
$$;

-- The five views are the same shape; only the kind and the geometry type
-- differ, and Postgres has no way to say that once. Served in 2D: QGIS draws
-- in 2D, a declared Z would refuse what it sends before the trigger runs, and
-- the Z the table holds is put back on the way in by feature_3d (0029).
CREATE VIEW gis.feature_road AS
SELECT id, st_force2d(geom)::geometry(LineString, 4326) AS geom FROM feature
WHERE kind = 'road' AND deleted_at IS NULL;
CREATE VIEW gis.feature_forest AS
SELECT id, st_force2d(geom)::geometry(Polygon, 4326) AS geom FROM feature
WHERE kind = 'forest' AND deleted_at IS NULL;
CREATE VIEW gis.feature_water AS
SELECT id, st_force2d(geom)::geometry(Polygon, 4326) AS geom FROM feature
WHERE kind = 'water' AND deleted_at IS NULL;
CREATE VIEW gis.feature_footprint AS
SELECT id, st_force2d(geom)::geometry(Polygon, 4326) AS geom FROM feature
WHERE kind = 'footprint' AND deleted_at IS NULL;
CREATE VIEW gis.feature_terrainmod AS
SELECT id, st_force2d(geom)::geometry(Polygon, 4326) AS geom FROM feature
WHERE kind = 'terrainmod' AND deleted_at IS NULL;

CREATE TRIGGER gis_write INSTEAD OF INSERT OR UPDATE OR DELETE ON gis.feature_road
FOR EACH ROW EXECUTE FUNCTION gis_feature_write('road');
CREATE TRIGGER gis_write INSTEAD OF INSERT OR UPDATE OR DELETE ON gis.feature_forest
FOR EACH ROW EXECUTE FUNCTION gis_feature_write('forest');
CREATE TRIGGER gis_write INSTEAD OF INSERT OR UPDATE OR DELETE ON gis.feature_water
FOR EACH ROW EXECUTE FUNCTION gis_feature_write('water');
CREATE TRIGGER gis_write INSTEAD OF INSERT OR UPDATE OR DELETE ON gis.feature_footprint
FOR EACH ROW EXECUTE FUNCTION gis_feature_write('footprint');
CREATE TRIGGER gis_write INSTEAD OF INSERT OR UPDATE OR DELETE ON gis.feature_terrainmod
FOR EACH ROW EXECUTE FUNCTION gis_feature_write('terrainmod');

GRANT SELECT, INSERT, UPDATE, DELETE ON gis.feature_road, gis.feature_forest,
    gis.feature_water, gis.feature_footprint, gis.feature_terrainmod TO geoserver;
