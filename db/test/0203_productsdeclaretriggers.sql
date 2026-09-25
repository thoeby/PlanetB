-- A product says what sets it off, and the world hears it once (db/0203).
BEGIN;
SELECT plan(14);

SET client_min_messages = warning;
SET search_path = api, public;

CREATE TEMP TABLE who AS
SELECT register('gate200@example.com', 'password12') AS ben,
       register('walk200@example.com', 'password12') AS dora;
GRANT SELECT ON who TO player, admin, flow;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;

SELECT lives_ok($$SELECT check_marks('{"triggers": [{"kind": "near", "params": {"m": 5}},
    {"kind": "somethingnew", "params": {}}], "rate": 2}'::jsonb)$$,
    'any word is a kind: kinds grow in the page, not in a list here');
SELECT throws_like($$SELECT check_marks('{"triggers": [{"kind": "near me"}]}'::jsonb)$$,
    '%not a kind of trigger%', 'but a kind is one word');
SELECT throws_like($$SELECT check_marks('{"triggers": [{"kind": "near", "params": 5}]}'::jsonb)$$,
    '%params are%', 'and its params an object');
SELECT isnt(asset_name_for(repeat('a', 64), '{"triggers": [{"kind": "near", "params": {"m": 5}}]}'),
            asset_name_for(repeat('a', 64), '{"triggers": [{"kind": "near", "params": {"m": 10}}]}'),
            'a gate that opens at five metres is not the one that opens at ten');
SELECT is(asset_name_for(repeat('a', 64), '{}'), derive_san(repeat('a', 64)),
          'and an unmarked model keeps the number it always had');

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'glb', 10, 'canon-v2');
INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                   tex_bytes, license, creator_id, type, parts)
SELECT 'SGATEGATEGATE', repeat('a', 64), 2, 'Tor', 'prop', '{}'::jsonb, 10, 0,
    'cc0', who.ben, 'model',
    '{"triggers": [{"kind": "near", "params": {"m": 5}}], "rate": 2}'::jsonb
FROM who;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000200a1'::uuid,
    st_setsrid(st_makeenvelope(7.86, 46.285, 7.864, 46.287), 4326), who.ben, 14
FROM who;
INSERT INTO instance (id, area_id, san, lon, lat)
VALUES ('00000000-0000-0000-0000-0000000200b1'::uuid,
        '00000000-0000-0000-0000-0000000200a1'::uuid, 'SGATEGATEGATE', 7.862, 46.286);
CREATE TEMP TABLE thing AS SELECT '00000000-0000-0000-0000-0000000200b1'::uuid AS id;
GRANT SELECT ON thing TO player, admin, flow;

-- Anybody walking past sets it off; it is the owner who reads what happened.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', dora, 'role', 'player')::text, true) FROM who;
SELECT ok(emit_trigger((SELECT id FROM thing), 'near', NULL, 100) > 0,
          'walking up to it sets it off once');
SELECT throws_like($$SELECT emit_trigger((SELECT id FROM thing), 'click')$$,
    '%not set off by click%', 'a kind the product never declared is refused');
SELECT ok(emit_trigger((SELECT id FROM thing), 'near') > 0, 'twice is within its rate');
SELECT throws_like($$SELECT emit_trigger((SELECT id FROM thing), 'near')$$,
    '%at most 2 times a minute%', 'and the third firing that minute is refused');
SELECT is((world_events(0) -> 'events'), '[]'::jsonb,
          'a passer-by does not read who walked past on somebody else''s land');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
SELECT is(jsonb_array_length(world_events(0) -> 'events'), 2,
          'the owner reads both firings');
SELECT is(world_events(0) #>> '{events,0,data,params,m}', '5',
          'each with the params the product gave it');
SELECT is((world_events(0) ->> 'last_id')::bigint,
          (SELECT max(id) FROM world_event), 'and the number to ask after next time');
SELECT is(jsonb_array_length(world_events((world_events(0) ->> 'last_id')::bigint) -> 'events'),
          0, 'asked after it, nothing new');

SELECT * FROM finish();
ROLLBACK;
