BEGIN;
SELECT plan(5);

SELECT has_function('public', 'area_defaults', 'area_defaults exists');
SELECT has_function('public', 'feature_defaults', 'feature_defaults exists');
SELECT has_function('public', 'instance_defaults', 'instance_defaults exists');

-- Nobody to own anything yet: the reason is said, not hidden in a NOT NULL.
SELECT throws_like(
    $$INSERT INTO area (id, geom, owner_id, detail, rules, created_at)
      VALUES (gen_random_uuid(),
              st_geomfromtext('POLYGON((7 46, 7.1 46, 7.1 46.1, 7 46.1, 7 46))', 4326),
              NULL, NULL, NULL, NULL)$$,
    '%create one in Setup first%',
    'an area with no admin to own it says so'
);

INSERT INTO auth.user (email, pw_hash, role) VALUES ('draw@example.com', 'x', 'admin');

-- What QGIS sends for a feature with every field left blank.
INSERT INTO area (id, geom, owner_id, detail, rules, created_at)
VALUES (gen_random_uuid(),
        st_geomfromtext('POLYGON((7 46, 7.1 46, 7.1 46.1, 7 46.1, 7 46))', 4326),
        null, null, null, null);

SELECT is(
    (SELECT detail FROM area WHERE owner_id = gis.default_owner()),
    14::smallint,
    'blank fields from QGIS become the defaults'
);

SELECT * FROM finish();
ROLLBACK;
