-- 0029_gistables.sql — GeoServer publishes the tables, not views of them.
--
-- Every drawable layer in 0008 is a view, and a view has no primary key. That
-- leaves GeoTools deciding the layer is read-only unless the store is told to
-- consult gis.gt_pk_metadata, a setting that lives in GeoServer's own config
-- and is one wrong click, cache or copy away from not being there — and when it
-- is not, QGIS says "area is read-only" at Save and nothing explains why.
--
-- A table has a real primary key. GeoTools sees it, generates the uuid itself,
-- and the layer is writable with nothing configured on the GeoServer side at
-- all. So the admin path (0008, Invariant 9) now publishes feature, area and
-- instance directly, schema public, and this migration gives those tables the
-- defaults the views carried so drawing in QGIS still types nothing.
--
-- The gis views stay; gis.tile is still the read-only overview layer.

-- The operator drawing through GeoServer is the admin (see 0028). That
-- function reads auth.user, which the geoserver role may not — so as a plain
-- default it fails at the first Save with "permission denied for schema auth".
-- It answers one question, "who is the admin", and exposes nothing else, so it
-- runs as its owner. BYPASSRLS on the role was always the admin path (Inv. 9).
ALTER FUNCTION gis.default_owner() SECURITY DEFINER;
ALTER TABLE area ALTER COLUMN owner_id SET DEFAULT gis.default_owner();

-- QGIS draws in two dimensions; feature.geom was declared GeometryZ, and the
-- declared type is checked as the value comes in, before any trigger runs, so
-- the very first Save fails with "Column has Z dimension but geometry does
-- not". PostGIS's typmod cannot say "two or three, I will fix it up", so the
-- column loses its typmod and the same promises are kept one step later: a
-- trigger forces every row to three dimensions on the way in, and a CHECK
-- holds the SRID and the Z that the typmod used to. client/js/edit.js and
-- diff_geom() in 0022 already send 3D and keep working unchanged.
-- Six views select that column, and Postgres will not retype a column a view
-- depends on, so they are dropped and put back exactly as 0007 and 0008 made
-- them. The gis feature views are kept for anyone who has them open; GeoServer
-- no longer publishes them.
DROP VIEW api.feature, gis.feature_road, gis.feature_forest, gis.feature_water,
    gis.feature_footprint, gis.feature_terrainmod;

ALTER TABLE feature ALTER COLUMN geom TYPE geometry;
ALTER TABLE feature ADD CONSTRAINT feature_geom_4326_3d
    CHECK (st_srid(geom) = 4326 AND st_ndims(geom) = 3);

CREATE VIEW api.feature WITH (security_invoker = true) AS SELECT * FROM public.feature;
GRANT SELECT ON api.feature TO anon, player, admin;
GRANT INSERT, UPDATE, DELETE ON api.feature TO player, admin;

CREATE VIEW gis.feature_road AS
SELECT * FROM feature WHERE kind = 'road' AND deleted_at IS NULL WITH CHECK OPTION;
CREATE VIEW gis.feature_forest AS
SELECT * FROM feature WHERE kind = 'forest' AND deleted_at IS NULL WITH CHECK OPTION;
CREATE VIEW gis.feature_water AS
SELECT * FROM feature WHERE kind = 'water' AND deleted_at IS NULL WITH CHECK OPTION;
CREATE VIEW gis.feature_footprint AS
SELECT * FROM feature WHERE kind = 'footprint' AND deleted_at IS NULL WITH CHECK OPTION;
CREATE VIEW gis.feature_terrainmod AS
SELECT * FROM feature WHERE kind = 'terrainmod' AND deleted_at IS NULL WITH CHECK OPTION;
ALTER VIEW gis.feature_road ALTER COLUMN kind SET DEFAULT 'road';
ALTER VIEW gis.feature_forest ALTER COLUMN kind SET DEFAULT 'forest';
ALTER VIEW gis.feature_water ALTER COLUMN kind SET DEFAULT 'water';
ALTER VIEW gis.feature_footprint ALTER COLUMN kind SET DEFAULT 'footprint';
ALTER VIEW gis.feature_terrainmod ALTER COLUMN kind SET DEFAULT 'terrainmod';
GRANT SELECT, INSERT, UPDATE, DELETE ON gis.feature_road, gis.feature_forest,
    gis.feature_water, gis.feature_footprint, gis.feature_terrainmod TO geoserver;

CREATE FUNCTION feature_force_3d() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    new.geom := st_force3d(new.geom);
    RETURN new;
END;
$$;

-- Named to sort before feature_area_default and feature_bump_rev; same-timing
-- triggers fire in name order and both of those read the geometry.
CREATE TRIGGER feature_3d BEFORE INSERT OR UPDATE ON feature
FOR EACH ROW EXECUTE FUNCTION feature_force_3d();
