BEGIN;
SELECT plan(9);

SELECT has_trigger('public', 'feature', 'feature_3d', 'feature_3d is on feature');
SELECT has_trigger('gis', 'feature_road', 'gis_write', 'gis.feature_road is writable through a trigger');
SELECT has_trigger('gis', 'instance', 'gis_instance_write', 'gis.instance is writable through a trigger');
SELECT is(
    (SELECT array_agg(column_name::text ORDER BY ordinal_position)
     FROM information_schema.columns WHERE table_schema = 'gis' AND table_name = 'area'),
    ARRAY['id', 'geom', 'detail'],
    'gis.area shows only what a drawer touches'
);

-- Nobody to own anything yet: the reason is said, not hidden in a NOT NULL.
SELECT throws_like(
    $$INSERT INTO gis.area (geom, detail)
      VALUES (st_geomfromtext('POLYGON((7 46, 7.1 46, 7.1 46.1, 7 46.1, 7 46))', 4326), 0)$$,
    '%create one in Setup first%',
    'an area with no admin to own it says so'
);

INSERT INTO auth.user (email, pw_hash, role) VALUES ('draw@example.com', 'x', 'admin');

-- What GeoServer sends for a Save with detail left blank: 0, and no id.
INSERT INTO gis.area (geom, detail)
VALUES (st_geomfromtext('POLYGON((7 46, 7.1 46, 7.1 46.1, 7 46.1, 7 46))', 4326), 0);
SELECT is((SELECT (detail, owner_id = gis.default_owner()) FROM area), (14::smallint, true),
          'a blank detail is the baseline and the admin owns it');

-- A 2D road drawn through its own layer.
INSERT INTO gis.feature_road (geom)
VALUES (st_geomfromtext('LINESTRING(7.01 46.01, 7.02 46.02)', 4326));
SELECT is((SELECT (kind, st_ndims(geom), area_id IS NOT NULL) FROM feature), ('road', 3, true),
          'the layer sets the kind, the table adds the Z and the area');

UPDATE gis.feature_road SET geom = st_geomfromtext('LINESTRING(7.01 46.01, 7.03 46.03)', 4326);
SELECT is((SELECT round(st_xmax(geom)::numeric, 2) FROM feature), 7.03, 'moving the road moves the feature');

-- A point placed in QGIS: every column sent, blanks as 0.
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'glb', 100, 'canon-v1');
INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                   tex_bytes, license, creator_id)
SELECT 'SPUJCSX4KZLJL', repeat('a', 64), 1, 'pine', 'tree', '{}'::jsonb, 10, 0,
       'cc0', id FROM auth.user WHERE email = 'draw@example.com';
INSERT INTO gis.instance (san, geom, h, yaw, pitch, roll, scale)
VALUES ('SPUJCSX4KZLJL', st_setsrid(st_makepoint(7.05, 46.05), 4326), 0, 0, 0, 0, 0);
SELECT is((SELECT (lon, lat, scale) FROM instance),
          (7.05::double precision, 46.05::double precision, 1::real),
          'the point became lon, lat, and a blank scale became 1');

SELECT * FROM finish();
ROLLBACK;
