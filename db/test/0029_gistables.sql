BEGIN;
SELECT plan(4);

SELECT has_function('public', 'feature_force_3d', 'feature_force_3d exists');
SELECT has_trigger('public', 'feature', 'feature_3d', 'feature_3d is on feature');

-- The admin path (BYPASSRLS) is what GeoServer uses; the test runs as the
-- migration owner, which is a superuser, and that is the same for RLS.
INSERT INTO auth.user (email, pw_hash, role) VALUES ('draw@example.com', 'x', 'admin')
ON CONFLICT DO NOTHING;

INSERT INTO area (geom)
VALUES (st_geomfromtext('POLYGON((7 46, 7.1 46, 7.1 46.1, 7 46.1, 7 46))', 4326));

SELECT is(
    (SELECT owner_id FROM area WHERE st_xmin(geom) = 7),
    gis.default_owner(),
    'an area drawn with nothing typed belongs to the admin'
);

INSERT INTO feature (kind, geom)
VALUES ('road', st_geomfromtext('LINESTRING(7.01 46.01, 7.02 46.02)', 4326));

SELECT is(
    (SELECT st_ndims(geom)::int FROM feature WHERE kind = 'road'
     ORDER BY id LIMIT 1),
    3,
    'a 2D line drawn in QGIS is stored with a Z'
);

SELECT * FROM finish();
ROLLBACK;
