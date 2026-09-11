-- 0029_qgis.sql — drawing the world in QGIS, through GeoServer, actually works.
--
-- What GeoServer and QGIS do, found by running them (GeoServer 2.26):
--   * a layer with no primary key is served read-only; the store names
--     gis.gt_pk_metadata (0008) so views have one;
--   * every published column is sent, blanks as '' or 0 rather than NULL, and
--     '' into jsonb is refused before any trigger runs — so the layers are
--     views with only the columns a drawer touches, and publishing a subset of
--     a table's columns is no alternative (that makes the layer read-only);
--   * QGIS draws in 2D, and a typmod that demands a Z refuses the row before a
--     trigger can add one;
--   * a generated column cannot be inserted into (instance.geom).
-- Everything else — owner, area, kind, revision, timestamps — is filled in by
-- the table's defaults and triggers. The admin path stays the one write path
-- without row-level security (0008, Invariant 9).

-- ------------------------------------------------------------------- area
-- The operator drawing through GeoServer is the admin (0028); that function
-- reads auth.user, which the geoserver role may not, so it runs as its owner.
ALTER FUNCTION gis.default_owner() SECURITY DEFINER;
ALTER TABLE area ALTER COLUMN owner_id SET DEFAULT gis.default_owner();

CREATE FUNCTION area_defaults() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    new.id := coalesce(new.id, gen_random_uuid());
    new.owner_id := coalesce(new.owner_id, gis.default_owner());
    -- GeoServer's blank number is 0; 0 is not a zoom, it means the baseline.
    new.detail := CASE WHEN coalesce(new.detail, 0) = 0 THEN 14 ELSE new.detail END;
    new.rules := coalesce(new.rules, '{"required_approvals": 1}'::jsonb);
    new.created_at := coalesce(new.created_at, now());
    IF new.owner_id IS NULL THEN
        RAISE EXCEPTION 'no account to own this yet — create one in Setup first';
    END IF;
    RETURN new;
END;
$$;
-- Leading 0 so it sorts before the other BEFORE triggers on the table.
CREATE TRIGGER area_0_defaults BEFORE INSERT ON area
FOR EACH ROW EXECUTE FUNCTION area_defaults();

DROP VIEW gis.area;
CREATE VIEW gis.area AS SELECT id, geom, detail FROM area;

-- ---------------------------------------------------------------- feature
-- feature.geom was geometry(GeometryZ, 4326): the typmod refuses a 2D row
-- before any trigger runs. The column loses the typmod; a trigger forces 3D
-- on the way in and a CHECK keeps the SRID and the Z. Six views select the
-- column and must go first; api.feature comes back exactly as 0007 made it.
DROP VIEW api.feature, gis.feature_road, gis.feature_forest, gis.feature_water,
    gis.feature_footprint, gis.feature_terrainmod;
ALTER TABLE feature ALTER COLUMN geom TYPE geometry;
ALTER TABLE feature ADD CONSTRAINT feature_geom_4326_3d
    CHECK (st_srid(geom) = 4326 AND st_ndims(geom) = 3);

CREATE VIEW api.feature WITH (security_invoker = true) AS SELECT * FROM public.feature;
GRANT SELECT ON api.feature TO anon, player, admin;
GRANT INSERT, UPDATE, DELETE ON api.feature TO player, admin;

CREATE FUNCTION feature_force_3d() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    new.geom := st_force3d(new.geom);
    RETURN new;
END;
$$;
CREATE FUNCTION feature_defaults() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    new.id := coalesce(new.id, gen_random_uuid());
    new.props := coalesce(new.props, '{}'::jsonb);
    new.rev := coalesce(new.rev, 1);
    IF new.kind IS NULL THEN
        RAISE EXCEPTION 'kind is empty — one of road, forest, water, footprint, terrainmod';
    END IF;
    RETURN new;
END;
$$;
-- Named to sort before feature_area_default and feature_bump_rev (0028, 0004),
-- which read what these fill in.
CREATE TRIGGER feature_0_defaults BEFORE INSERT ON feature
FOR EACH ROW EXECUTE FUNCTION feature_defaults();
CREATE TRIGGER feature_3d BEFORE INSERT OR UPDATE ON feature
FOR EACH ROW EXECUTE FUNCTION feature_force_3d();

-- One typed layer per kind: a road is a line, the rest polygons, and QGIS
-- will not draw on a layer of unknown geometry type. Served 2D — what QGIS
-- draws — and written through the trigger; the table puts the Z back.
CREATE FUNCTION gis_feature_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF tg_op = 'DELETE' THEN
        DELETE FROM feature WHERE id = old.id;
        RETURN old;
    END IF;
    IF tg_op = 'INSERT' THEN
        INSERT INTO feature (id, kind, geom)
        VALUES (coalesce(new.id, gen_random_uuid()), tg_argv[0], new.geom)
        RETURNING id INTO new.id;
        RETURN new;
    END IF;
    UPDATE feature SET geom = new.geom WHERE id = old.id;
    RETURN new;
END;
$$;

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

-- --------------------------------------------------------------- instance
CREATE FUNCTION instance_defaults() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    new.id := coalesce(new.id, gen_random_uuid());
    new.h := coalesce(new.h, 0);
    new.yaw := coalesce(new.yaw, 0);
    new.pitch := coalesce(new.pitch, 0);
    new.roll := coalesce(new.roll, 0);
    new.scale := coalesce(new.scale, 1);
    new.props := coalesce(new.props, '{}'::jsonb);
    new.rev := coalesce(new.rev, 1);
    RETURN new;
END;
$$;
CREATE TRIGGER instance_0_defaults BEFORE INSERT ON instance
FOR EACH ROW EXECUTE FUNCTION instance_defaults();

-- The point placed in QGIS becomes lon and lat; geom itself is generated.
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

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gis TO geoserver;
