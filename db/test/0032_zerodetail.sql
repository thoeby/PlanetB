BEGIN;
SELECT plan(1);

INSERT INTO auth.user (email, pw_hash, role) VALUES ('draw@example.com', 'x', 'admin');

-- Who is drawing. gis.default_owner() is current_user_id() since
-- db/0065_playerroles.sql: land nobody is signed in for is nobody's.
SELECT set_config('request.jwt.claims',
                  json_build_object('sub', (SELECT id FROM auth.user
                                            WHERE email = 'draw@example.com'),
                                    'role', 'admin')::text, true);

-- GeoServer's own blank: 0, not NULL.
INSERT INTO area (geom, detail, id)
VALUES (st_geomfromtext('POLYGON((8 46, 8.1 46, 8.1 46.1, 8 46.1, 8 46))', 4326), 0,
        gen_random_uuid());
SELECT is(
    (SELECT detail FROM area WHERE st_xmin(geom) = 8),
    14::smallint,
    'a detail of 0 from GeoServer is the baseline'
);

SELECT * FROM finish();
ROLLBACK;
