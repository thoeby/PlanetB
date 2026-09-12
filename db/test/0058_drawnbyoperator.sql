-- What you draw belongs to the operator, not to the oldest row in auth.user
-- (db/0058_drawnbyoperator.sql).
BEGIN;
SELECT plan(6);

-- An older admin than the operator, which is the case that broke it: a seed,
-- a test fixture, a colleague who registered first.
INSERT INTO auth.user (id, email, pw_hash, role, created_at) VALUES
('00000000-0000-0000-0000-00000000f001', 'older-admin@example.com', 'x', 'admin',
 now() - interval '1 day'),
('00000000-0000-0000-0000-00000000f002', 'operator@example.com', 'x', 'admin', now());

-- A world whose ground is not set yet. (This database may already hold one,
-- and other admins besides the two above; the assertions are about behaviour,
-- not about which fixture happens to be oldest.)
DELETE FROM ground;

-- With no ground set there is nothing better to go on than age.
SELECT is(gis.default_owner(),
          (SELECT id FROM auth.user WHERE role = 'admin'
           ORDER BY created_at, id LIMIT 1),
          'with no ground, the oldest admin still owns what is drawn');
SELECT is(drawing_as() ->> 'from_ground', 'false',
          'and the panel is told that this is a guess');

-- Setting the ground is the operator saying which world this is.
INSERT INTO ground (geoserver_url, coverage, extent, set_by)
VALUES ('http://localhost:8080/geoserver', 'demo:dem',
        st_makeenvelope(7.9, 46.9, 8.2, 47.2, world_srid()),
        '00000000-0000-0000-0000-00000000f002')
ON CONFLICT (only_one) DO UPDATE SET set_by = excluded.set_by;

SELECT is(gis.default_owner(), '00000000-0000-0000-0000-00000000f002'::uuid,
          'once the ground is set, the operator owns what is drawn');
SELECT is(drawing_as() ->> 'email', 'operator@example.com',
          'and the panel can say who that is');
SELECT is(drawing_as() ->> 'from_ground', 'true',
          'and that it is known rather than guessed');

-- The whole point: an area drawn through GeoServer lands on the operator.
SET ROLE geoserver;
INSERT INTO gis.area (geom, detail) VALUES
    (st_geomfromtext('MULTIPOLYGON(((8.0 47.0, 8.1 47.0, 8.1 47.1, 8.0 47.0)))',
                     world_srid()), 0);
RESET ROLE;
SELECT is((SELECT owner_id FROM area ORDER BY created_at DESC LIMIT 1),
          '00000000-0000-0000-0000-00000000f002'::uuid,
          'a land drawn in QGIS belongs to the operator');

SELECT * FROM finish();
ROLLBACK;
