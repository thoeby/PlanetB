BEGIN;
SELECT plan(3);

SELECT is(
    (SELECT array_agg(column_name::text ORDER BY ordinal_position)
     FROM information_schema.columns WHERE table_schema = 'gis' AND table_name = 'area'),
    ARRAY['id', 'geom', 'detail'],
    'gis.area shows only what a drawer touches'
);

INSERT INTO auth.user (email, pw_hash, role) VALUES ('draw@example.com', 'x', 'admin');

-- What GeoServer sends for a Save with detail left blank: 0, and no id.
INSERT INTO gis.area (geom, detail)
VALUES (st_geomfromtext('POLYGON((7 46, 7.1 46, 7.1 46.1, 7 46.1, 7 46))', 4326), 0);
SELECT is((SELECT detail FROM area), 14::smallint, 'drawn through the view, defaulted by the table');

-- gis.feature itself is gone: 0034 replaced it with one typed layer per kind,
-- because a layer of unknown geometry type cannot be drawn on in QGIS.
INSERT INTO gis.feature_road (geom)
VALUES (st_geomfromtext('LINESTRING(7.01 46.01, 7.02 46.02)', 4326));
SELECT is((SELECT st_ndims(geom)::int FROM feature), 3,
          'a 2D road through the view is stored 3D');

SELECT * FROM finish();
ROLLBACK;
