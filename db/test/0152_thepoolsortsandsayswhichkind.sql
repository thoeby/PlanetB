-- The redo buttons are allowed to run, the pool knows three kinds of work and
-- whose ground it is, and it cuts on whichever sort was asked for.
BEGIN;
SELECT plan(7);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('kind152@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;

SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.70, 46.20, 8.10, 46.40);
SELECT compile_ground();

-- A player, not an admin, may press Redo the renders on ground that is theirs.
SELECT ok(has_function_privilege('player', 'redo_renders(bigint)', 'EXECUTE'),
    'a player may run redo_renders (it authorises itself)');
SELECT ok(has_function_privilege('player', 'redo_land_renders(uuid)', 'EXECUTE'),
    'and a whole land of it');
SELECT ok(has_function_privilege('admin', 'redo_ground_renders()', 'EXECUTE'),
    'and an admin the whole world');

-- Every job is in exactly one kind, so the three add up to all of them: a tab
-- whose count does not agree with its page is a pager that walks off the end.
CREATE TEMP TABLE p AS SELECT pool_page(8.09, 46.39, 'all', 4, 0, 'near') AS j;
SELECT is(((SELECT j FROM p) ->> 'render')::int + ((SELECT j FROM p) ->> 'train')::int
    + ((SELECT j FROM p) ->> 'publish')::int, ((SELECT j FROM p) ->> 'all')::int,
    'the three kinds are all of them, and no job is in two');
SELECT ok(((SELECT j FROM p) ->> 'mine')::int <= ((SELECT j FROM p) ->> 'all')::int,
    'and the caller''s own ground is some of it');
SELECT is(((SELECT pool_page(8.09, 46.39, 'train', 4, 0, 'near') ->> 'total')::int),
    ((SELECT j FROM p) ->> 'train')::int,
    'asking for one kind counts that kind, not all of them');

-- The sort is what cuts the page, not what reorders one already cut.
SELECT is((SELECT (jsonb_array_elements(pool_page(8.09, 46.39, 'all', 1, 0, 'near')
                                        -> 'rows') ->> 'job')::bigint),
    (SELECT j.id FROM job j INNER JOIN tile t
       ON t.z = j.z AND t.x = j.x AND t.y = j.y
     WHERE j.state = 'open' AND j.target_version = t.expected_version
       AND EXISTS (SELECT 1 FROM atom a WHERE a.job_id = j.id AND a.state = 'ready')
     ORDER BY st_distance(st_centroid(tile_bbox(j.z, j.x, j.y))::geography,
                st_setsrid(st_makepoint(8.09, 46.39), world_srid())::geography) ASC,
              j.bounty DESC, j.id ASC
     LIMIT 1),
    'asking for one nearest tile gives the nearest tile there is');

SELECT * FROM finish();
ROLLBACK;
