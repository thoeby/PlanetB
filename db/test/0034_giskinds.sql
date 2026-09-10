BEGIN;
SELECT plan(4);

SELECT has_view('gis', 'feature_road', 'gis.feature_road exists');
SELECT is(
    (SELECT array_agg(column_name::text ORDER BY ordinal_position)
     FROM information_schema.columns WHERE table_schema = 'gis' AND table_name = 'feature_forest'),
    ARRAY['id', 'geom'],
    'a kind layer shows only id and geometry'
);

INSERT INTO auth.user (email, pw_hash, role) VALUES ('draw@example.com', 'x', 'admin');
INSERT INTO gis.area (geom, detail)
VALUES (st_geomfromtext('POLYGON((7 46, 7.1 46, 7.1 46.1, 7 46.1, 7 46))', 4326), 0);

-- A 2D road drawn in QGIS through its own layer.
INSERT INTO gis.feature_road (geom)
VALUES (st_geomfromtext('LINESTRING(7.01 46.01, 7.02 46.02)', 4326));
SELECT is((SELECT (kind, st_ndims(geom)) FROM feature), ('road', 3),
          'the layer sets the kind, the table adds the Z');

UPDATE gis.feature_road SET geom = st_geomfromtext('LINESTRING(7.01 46.01, 7.03 46.03)', 4326);
SELECT is((SELECT round(st_xmax(geom)::numeric, 2) FROM feature), 7.03, 'moving the road moves the feature');

SELECT * FROM finish();
ROLLBACK;
