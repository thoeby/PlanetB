-- A player is one worker however many tabs they open (db/0181).
BEGIN;
SELECT plan(5);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('one181@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;

SELECT is(my_worker('{"webgpu": true}'), my_worker('{"webgpu": false}'),
    'two tabs asking are one worker');
SELECT is((SELECT count(*) FROM worker WHERE user_id = (SELECT owner_id FROM ids)), 1::bigint,
    'and there is one row');
SELECT throws_like($$INSERT INTO worker (user_id) SELECT owner_id FROM ids$$,
    '%worker_one_per_user_idx%', 'a second row cannot be made');

-- A tab may only put down a piece it holds.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;
SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.86, 46.28, 7.92, 46.33);
CREATE TEMP TABLE a AS SELECT create_area(
    '{"type":"Polygon","coordinates":[[[7.880,46.295],[7.890,46.295],
                                       [7.890,46.305],[7.880,46.305],[7.880,46.295]]]}'::jsonb,
    14, 'one181') AS id;
SELECT recompile_land((SELECT id FROM a));
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;
CREATE TEMP TABLE held AS SELECT * FROM claim_for((SELECT jid FROM j), '{}');
CREATE TEMP TABLE other AS SELECT register('two181@example.com', 'password12') AS id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', id, 'role', 'player')::text, true) FROM other;
SELECT throws_like($$SELECT fail_atom((SELECT id FROM held), 'no')$$, '%not in your hands%',
    'another worker cannot fail it');
SELECT throws_like($$SELECT hand_back_atom((SELECT id FROM held))$$, '%not in your hands%',
    'nor hand it back');

SELECT * FROM finish();
ROLLBACK;
