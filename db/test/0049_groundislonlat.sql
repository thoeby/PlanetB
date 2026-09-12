-- The world stands on longitude and latitude, and says so when it is handed
-- anything else (db/0049_groundislonlat.sql).
BEGIN;
SELECT plan(4);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('g@example.com', 'password12') AS uid;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'admin')::text, true) FROM ids;

-- A Swiss DEM's own envelope, in LV95 metres. Stored as lon/lat it made a
-- world that no tile in Switzerland was inside.
SELECT throws_ok(
    $$SELECT set_ground('http://gs', 'dem', 2633000, 1124000, 2640000, 1130000)$$,
    null, null, 'an envelope in metres is refused');
SELECT is((SELECT count(*)::int FROM ground), 0, 'and nothing is stored');

SELECT lives_ok(
    $$SELECT set_ground('http://gs', 'dem', 7.8, 46.1, 8.0, 46.3)$$,
    'the same coverage in lon/lat is taken');
SELECT ok((SELECT st_xmax(extent) FROM ground) = 8.0, 'as it was given');

SELECT * FROM finish();
ROLLBACK;
