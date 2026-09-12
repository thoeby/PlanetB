-- The drawing layers, one per kind, generated from the world's vocabulary
-- (db/0041_gisforms.sql replaced db/0034's fixed five).
BEGIN;
SELECT plan(6);

SELECT has_view('gis', 'f_road', 'a road layer exists');
SELECT has_view('gis', 'f_tree', 'so does one for a kind db/0034 never had');
SELECT is(
    (SELECT array_agg(column_name::text ORDER BY ordinal_position)
     FROM information_schema.columns
     WHERE table_schema = 'gis' AND table_name = 'f_forest'),
    (SELECT ARRAY['id', 'area_id', 'rev']
        || array_agg(p.name::text ORDER BY p.ordering, p.name) || ARRAY['geom']
     FROM property p WHERE p.kind = 'forest'),
    'a wood layer carries exactly the properties a wood may have'
);

INSERT INTO auth.user (email, pw_hash, role) VALUES ('draw@example.com', 'x', 'admin');

-- Who is drawing. gis.default_owner() is current_user_id() since
-- db/0065_playerroles.sql: land nobody is signed in for is nobody's, and the
-- trigger says so rather than guessing an admin.
SELECT set_config('request.jwt.claims',
                  json_build_object('sub', (SELECT id FROM auth.user
                                            WHERE email = 'draw@example.com'),
                                    'role', 'admin')::text, true);
INSERT INTO gis.area (geom, detail)
VALUES (st_geomfromtext('POLYGON((7 46, 7.1 46, 7.1 46.1, 7 46.1, 7 46))', 4326), 0);

-- A 2D road drawn in QGIS through its own layer.
INSERT INTO gis.f_road (geom)
VALUES (st_geomfromtext('LINESTRING(7.01 46.01, 7.02 46.02)', 4326));
SELECT is((SELECT (kind, st_ndims(geom)::int) FROM feature), ('road'::text, 3),
          'the layer sets the kind, the table adds the Z');

UPDATE gis.f_road SET geom = st_geomfromtext('LINESTRING(7.01 46.01, 7.03 46.03)', 4326);
SELECT is((SELECT round(st_xmax(geom)::numeric, 2) FROM feature), 7.03,
          'moving the road moves the feature');

-- What QGIS types into the form lands in props, where the compiler reads it.
INSERT INTO gis.f_forest (geom, leaf_type)
VALUES (st_geomfromtext('POLYGON((7.04 46.04, 7.05 46.04, 7.05 46.05, 7.04 46.05, 7.04 46.04))',
                        4326), 'broadleaved');
SELECT is((SELECT props ->> 'leaf_type' FROM feature WHERE kind = 'forest'),
          'broadleaved', 'a field in the form is a property on the feature');

SELECT * FROM finish();
ROLLBACK;
