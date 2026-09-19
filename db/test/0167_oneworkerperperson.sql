-- A person is one worker: my_worker is one row however it is raced, and the
-- rows that already doubled are folded into one.
BEGIN;
SELECT plan(5);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('rend167@example.com', 'password12') AS uid;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'player')::text, true) FROM ids;

SELECT is(my_worker('{"webgpu": true}'::jsonb), my_worker(NULL),
    'the same person is the same worker every time');
SELECT is((SELECT count(*)::int FROM worker WHERE user_id = (SELECT uid FROM ids)), 1,
    'and one row');
SELECT is((SELECT caps ->> 'webgpu' FROM worker WHERE user_id = (SELECT uid FROM ids)),
    'true', 'caps given are kept; NULL caps leave them alone');
SELECT throws_ok(
    $$INSERT INTO worker (user_id) SELECT uid FROM ids$$, '23505',
    NULL, 'a second row for one person is refused');

-- The heartbeat is the call that noticed: it has to find the claim under the
-- same worker the claim was made under.
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000167'::uuid,
       st_geomfromtext('POLYGON((7.8 46.29,7.81 46.29,7.81 46.30,7.8 46.30,7.8 46.29))', 4326),
       ids.uid, 18
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000167', 'building',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));
SELECT ensure_job(18, tile_x(7.805, 18), tile_y(46.295, 18));
CREATE TEMP TABLE held AS SELECT id FROM claim_atom('{}'::jsonb);
SELECT lives_ok($$SELECT heartbeat((SELECT id FROM held))$$,
    'the heartbeat finds the claim under the worker that made it');

SELECT * FROM finish();
ROLLBACK;
