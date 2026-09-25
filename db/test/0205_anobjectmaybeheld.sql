-- A thing may be picked up, carried, handed on and put down (db/0205).
BEGIN;
SELECT plan(19);

SET client_min_messages = warning;
SET search_path = api, public;

CREATE TEMP TABLE who AS
SELECT register('crate202@example.com', 'password12') AS ben,
       register('anna202@example.com', 'password12') AS anna,
       register('cara202@example.com', 'password12') AS cara;
GRANT SELECT ON who TO player, admin;
UPDATE auth.user SET name = 'Anna' WHERE id = (SELECT anna FROM who);

SELECT throws_like($$SELECT check_marks('{"hold": {"capacity": 0}}'::jsonb)$$,
    '%between 1 and 1000%', 'a container holds at least one thing');
SELECT isnt(asset_name_for(repeat('a', 64), '{"carry": {"kind": "crate"}}'),
            asset_name_for(repeat('a', 64), '{}'),
            'a crate that may be carried is another product than one that may not');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'glb', 10, 'canon-v2');
INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                   tex_bytes, license, creator_id, type, parts)
SELECT s, repeat('a', 64), 2, n, 'prop', '{}'::jsonb, 10, 0, 'cc0', who.ben, 'model', p
FROM who, (VALUES ('SCRATECRATECR', 'Kiste', '{"carry": {"kind": "crate"}}'::jsonb),
                  ('SCHESTCHESTCH', 'Truhe', '{"hold": {"capacity": 1, "kinds": ["crate"]}}'),
                  ('SBENCHBENCHBE', 'Bank', '{}')) v (s, n, p);
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000202a1'::uuid,
    st_setsrid(st_makeenvelope(7.86, 46.285, 7.864, 46.287), 4326), who.ben, 14
FROM who;
INSERT INTO instance (id, area_id, san, lon, lat)
VALUES ('00000000-0000-0000-0000-0000000202b1', '00000000-0000-0000-0000-0000000202a1',
        'SCRATECRATECR', 7.862, 46.286),
       ('00000000-0000-0000-0000-0000000202b2', '00000000-0000-0000-0000-0000000202a1',
        'SCHESTCHESTCH', 7.8622, 46.286),
       ('00000000-0000-0000-0000-0000000202b3', '00000000-0000-0000-0000-0000000202a1',
        'SBENCHBENCHBE', 7.8624, 46.286);
CREATE TEMP TABLE t AS SELECT '00000000-0000-0000-0000-0000000202b1'::uuid AS crate,
    '00000000-0000-0000-0000-0000000202b2'::uuid AS chest,
    '00000000-0000-0000-0000-0000000202b3'::uuid AS bench;
GRANT SELECT ON t TO player, admin;
CREATE TEMP TABLE v0 AS SELECT coalesce(sum(expected_version), 0) AS v FROM tile;
GRANT SELECT ON v0 TO player, admin;

SELECT ok((SELECT carry FROM instance WHERE id = (SELECT crate FROM t)),
          'the world knows the crate may be carried');
SELECT ok(NOT (SELECT tile_world(14, 8550, 5809) -> 'instances')
          @> jsonb_build_array(jsonb_build_object('san', 'SCRATECRATECR')),
          'and never bakes it into a tile');

-- Anna and Cara reach for it; one has it, the other is told who.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', anna, 'role', 'player')::text, true) FROM who;
SELECT is(take((SELECT crate FROM t)) ->> 'holder', 'Anna', 'Anna picks the crate up');
SELECT is((SELECT lon FROM instance WHERE id = (SELECT crate FROM t)), NULL,
          'and while she has it, it is nowhere on the ground');
SELECT is(jsonb_array_length(my_holdings()), 1, 'she is carrying one thing');
SELECT set_config('request.jwt.claims',
    json_build_object('sub', cara, 'role', 'player')::text, true) FROM who;
SELECT throws_like($$SELECT take((SELECT crate FROM t))$$, 'Anna has it.',
    'Cara, a moment late, is told who has it');
SELECT throws_like($$SELECT take((SELECT bench FROM t))$$, '%cannot be picked up%',
    'and a bench is not a thing anybody carries');
SELECT throws_like($$SELECT drop((SELECT crate FROM t), 7.8621, 46.286)$$,
    'You are not holding that.', 'nor may she put down what Anna holds');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', anna, 'role', 'player')::text, true) FROM who;
SELECT throws_like($$SELECT drop((SELECT crate FROM t), 8.5, 46.9)$$,
    '%only put Kiste down on land you build on%', 'not in somebody else''s valley');
SELECT is(drop((SELECT crate FROM t), 7.8631, 46.2865) ->> 'lon', '7.8631',
          'but back on the land it came from, a hundred metres on');
SELECT is((SELECT coalesce(sum(expected_version), 0) FROM tile), (SELECT v FROM v0),
          'and carrying it about dirtied no tile');

-- Handed on, and put into a chest.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
SELECT is(take((SELECT crate FROM t)) ->> 'holder_player', (SELECT ben::text FROM who),
          'Ben takes it');
SELECT is(give((SELECT crate FROM t), (SELECT cara::text FROM who)) ->> 'holder_player',
          (SELECT cara::text FROM who), 'and gives it to Cara');
SELECT set_config('request.jwt.claims',
    json_build_object('sub', cara, 'role', 'player')::text, true) FROM who;
SELECT is(give((SELECT crate FROM t), (SELECT chest::text FROM t)) ->> 'holder_instance',
          (SELECT chest::text FROM t), 'who puts it in the chest');
SELECT throws_like($$SELECT give((SELECT crate FROM t), (SELECT anna::text FROM who))$$,
    'That is not yours to give.', 'and it is not hers to give any more');
SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
SELECT is(give((SELECT crate FROM t), (SELECT anna::text FROM who)) ->> 'holder',
          'Anna', 'the chest''s land-owner hands it out of the chest');
SELECT throws_like($$SELECT give((SELECT bench FROM t), (SELECT chest::text FROM t))$$,
    'That is not yours to give.', 'nobody puts a bench standing on the ground anywhere');

SELECT * FROM finish();
ROLLBACK;
