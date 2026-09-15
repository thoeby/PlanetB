-- The ground has layers: more elevation, an albedo, a shade
-- (db/0106_groundlayers.sql).
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('layers@example.com', 'password12') AS admin_id,
       register('walker@example.com', 'password12') AS player_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'admin')::text, true) FROM ids;
SELECT set_ground('http://gs', 'dem', 7.80, 46.28, 7.83, 46.30);

SELECT ok(set_ground_layer('albedo', 'http://gs', 'ws:ortho', 7.80, 46.28, 7.83, 46.30) > 0,
    'an admin adds an orthophoto');
SELECT ok(set_ground_layer('dem', 'http://gs', 'ws:fine', 7.81, 46.29, 7.82, 46.30, 1) > 0,
    'and a second elevation');
SELECT throws_ok($$SELECT set_ground_layer('paint', 'http://gs', 'x', 7.80, 46.28, 7.83, 46.30)$$,
    '23514', NULL, 'a kind the world does not know is refused');
SELECT is((SELECT jsonb_array_length(ground_view() -> 'layers')), 2,
    'the ground says what it is made of');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', player_id, 'role', 'player')::text, true) FROM ids;
SELECT throws_ok($$SELECT set_ground_layer('shade', 'http://gs', 'x', 7.80, 46.28, 7.83, 46.30)$$,
    '42501', NULL, 'a player may not');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'admin')::text, true) FROM ids;
SELECT ok(drop_ground_layer((SELECT min(id) FROM ground_layer)), 'and an admin removes one');

SELECT * FROM finish();
ROLLBACK;
