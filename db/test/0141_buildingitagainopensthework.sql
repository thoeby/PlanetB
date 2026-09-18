-- Build it all again puts the land back in the pool. It used to mark the tiles
-- dirty, cancel the jobs that were building the version it replaced, and stop
-- there -- so the land left the pool and the nearest piece of work was the
-- first tile outside it.
BEGIN;
SELECT plan(5);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('again141@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;

SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.86, 46.28, 7.92, 46.33);
SELECT ok(compile_ground() > 0, 'the whole ground opens its jobs');

CREATE TEMP TABLE a AS SELECT create_area(
    '{"type":"Polygon","coordinates":[[[7.880,46.295],[7.890,46.295],
                                       [7.890,46.305],[7.880,46.305],[7.880,46.295]]]}'::jsonb,
    14, 'again141') AS id;

CREATE TEMP VIEW live AS
SELECT t.z, t.x, t.y FROM area_tiles((SELECT id FROM a)) at
INNER JOIN tile t ON t.z = at.z AND t.x = at.x AND t.y = at.y
INNER JOIN job j ON j.z = t.z AND j.x = t.x AND j.y = t.y
WHERE at.z = 14 AND j.state = 'open' AND j.target_version = t.expected_version;

CREATE TEMP TABLE mine AS SELECT count(*) AS n FROM area_tiles((SELECT id FROM a)) WHERE z = 14;
SELECT ok((SELECT n FROM mine) > 0, 'the land has z14 tiles of its own');
SELECT is((SELECT count(*) FROM live), (SELECT n FROM mine),
    'and every one of them has work open on it');

SELECT recompile_land((SELECT id FROM a));

SELECT is((SELECT count(*) FROM live), (SELECT n FROM mine),
    'and still does after building it all again');
SELECT is((SELECT count(*) FROM area_tiles((SELECT id FROM a)) at
           INNER JOIN tile t ON t.z = at.z AND t.x = at.x AND t.y = at.y
           INNER JOIN job j ON j.z = t.z AND j.x = t.x AND j.y = t.y
           WHERE j.state = 'open' AND j.target_version < t.expected_version), 0::bigint,
    'and none of its jobs is left building a version the world has moved past');

SELECT * FROM finish();
ROLLBACK;
