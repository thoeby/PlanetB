BEGIN;
SELECT plan(4);

SELECT has_view('gis', 'feature', 'gis.feature exists');
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

INSERT INTO gis.feature (kind, geom)
VALUES ('road', st_geomfromtext('LINESTRING(7.01 46.01, 7.02 46.02)', 4326));
SELECT is((SELECT st_ndims(geom) FROM feature), 3, 'a 2D road through the view is stored 3D');

SELECT * FROM finish();
ROLLBACK;
