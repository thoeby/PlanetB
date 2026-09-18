-- The world is as wide as every source of elevation it has, not as wide as the
-- first one: a dem layer beyond the base coverage is ground the world compiles
-- and land may be claimed on.
BEGIN;
SELECT plan(8);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('reach140@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;

DELETE FROM ground_layer;
SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.80, 46.20, 7.95, 46.35);

SELECT is(round(st_xmax(ground_reach())::numeric, 2), 7.95::numeric,
    'one coverage: the world reaches as far as it does');

-- A piece of ground five kilometres east of it, the way an operator adds a
-- survey next door (db/0106).
SELECT set_ground_layer('dem', 'http://gs.example/geoserver', 'dev:dem-east',
                        7.99, 46.20, 8.10, 46.35, 1);

SELECT is(round(st_xmax(ground_reach())::numeric, 2), 8.10::numeric,
    'adding elevation widens the world');
SELECT is(round(st_xmin(ground_reach())::numeric, 2), 7.80::numeric,
    'and does not narrow it');
SELECT is((ground_view() ->> 'east')::numeric, 8.10::numeric,
    'which is what the panel is told the world reaches');
SELECT is((ground_view() ->> 'coverage_east')::numeric, 7.95::numeric,
    'with the base coverage still named as its own box');

-- An albedo layer is a picture, not ground: it may not widen where a player
-- may stand, because nothing can be cut for elevation there.
SELECT set_ground_layer('albedo', 'http://gs.example/geoserver', 'dev:ortho',
                        8.50, 46.20, 8.60, 46.35, 0);
SELECT is(round(st_xmax(ground_reach())::numeric, 2), 8.10::numeric,
    'an orthophoto is not ground to stand on');

-- And land out on the new layer is land, where before it was refused.
SELECT lives_ok($$ SELECT create_area(
    '{"type":"Polygon","coordinates":[[[8.00,46.25],[8.02,46.25],
                                       [8.02,46.27],[8.00,46.27],[8.00,46.25]]]}'::jsonb,
    14, 'land on the new survey') $$,
    'land on the added elevation is claimable');
SELECT throws_ok($$ SELECT create_area(
    '{"type":"Polygon","coordinates":[[[9.50,46.25],[9.52,46.25],
                                       [9.52,46.27],[9.50,46.27],[9.50,46.25]]]}'::jsonb,
    14, 'land in the sea') $$, '23514', NULL,
    'and land where no elevation reaches is still refused');

SELECT * FROM finish();
ROLLBACK;
