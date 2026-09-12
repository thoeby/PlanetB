-- Nothing is drawn where the world is not (db/0062_insideground.sql).
BEGIN;
SELECT plan(6);

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-00000000f301', 'ground@example.com', 'x', 'admin');
DELETE FROM ground;
INSERT INTO ground (geoserver_url, coverage, extent, set_by)
VALUES ('http://localhost:8081/geoserver', 'splatworld:visp',
        st_makeenvelope(7.8545, 46.2759, 7.9085, 46.3119, world_srid()),
        '00000000-0000-0000-0000-00000000f301');

SELECT ok(inside_ground(st_geomfromtext('POINT(7.88 46.29)', 4326)),
          'a point in the Rhone valley is in this world');
SELECT ok(NOT inside_ground(st_geomfromtext('POINT(46.29 7.88)', 4326)),
          'the same numbers the other way round are not');

SELECT lives_ok($$SELECT refuse_outside_ground(
    st_geomfromtext('POINT(7.88 46.29)', 4326), 'this land')$$,
    'ground that is inside is not refused');

-- The two refusals a person can act on: one says what to change, the other
-- says where the world is.
SELECT throws_like($$SELECT refuse_outside_ground(
    st_geomfromtext('POINT(46.29 7.88)', 4326), 'Ben''s field')$$,
    '%longitude and latitude swapped%',
    'swapped coordinates are named as swapped');
SELECT throws_like($$SELECT refuse_outside_ground(
    st_geomfromtext('POINT(-73.9 40.7)', 4326), 'Ben''s field')$$,
    '%outside the world''s ground, which reaches 7.8545..7.9085 E%',
    'and somewhere else says where the world is');

-- A world whose ground has not been chosen refuses nothing: there is nothing
-- to be outside of yet (SPEC §3.1).
DELETE FROM ground;
SELECT lives_ok($$SELECT refuse_outside_ground(
    st_geomfromtext('POINT(-73.9 40.7)', 4326), 'anything')$$,
    'with no ground chosen, nothing is outside it');

SELECT * FROM finish();
ROLLBACK;
