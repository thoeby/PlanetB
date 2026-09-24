-- A flow runs on a process server under a key of its own (db/0195).
BEGIN;
SELECT plan(11);

SET client_min_messages = warning;

CREATE TEMP TABLE who AS
SELECT register('key195@example.com', 'password12') AS ben,
       register('key195c@example.com', 'password12') AS cara;
GRANT SELECT ON who TO player, flow;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'glb', 10, 'canon-v2');
SELECT register_artifact(repeat('e', 64), 'flow', 120, 'elx-v1');
INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                   tex_bytes, license, creator_id, type, parts)
SELECT 'SLAMPKEYAAAAB', repeat('a', 64), 2, 'Lampe', 'street', '{}'::jsonb, 10, 0,
       'cc0', who.ben, 'model',
       jsonb_build_object('ports', jsonb_build_array(
           jsonb_build_object('name', 'on', 'type', 'boolean', 'default', 'false')))
FROM who;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000195a1'::uuid,
       st_setsrid(st_makeenvelope(7.86, 46.285, 7.864, 46.287), 4326), ben, 14 FROM who
UNION ALL
SELECT '00000000-0000-0000-0000-0000000195a2'::uuid,
       st_setsrid(st_makeenvelope(7.87, 46.285, 7.874, 46.287), 4326), cara, 14 FROM who;
INSERT INTO instance (id, area_id, san, lon, lat)
VALUES ('00000000-0000-0000-0000-0000000195b1'::uuid,
        '00000000-0000-0000-0000-0000000195a1'::uuid, 'SLAMPKEYAAAAB', 7.862, 46.286),
       ('00000000-0000-0000-0000-0000000195b2'::uuid,
        '00000000-0000-0000-0000-0000000195a2'::uuid, 'SLAMPKEYAAAAB', 7.872, 46.286);

CREATE TEMP TABLE f AS
SELECT (save_flow(null, '00000000-0000-0000-0000-0000000195a1', 'Lamp at dusk',
                  repeat('e', 64), '{}'::jsonb, 0) ->> 'id')::uuid AS id,
       save_process_server(null, 'alpha', 'http://127.0.0.1:8091') AS server;
CREATE TEMP TABLE d AS
SELECT deploy_flow(f.id, f.server, repeat('e', 64), '7', '9') AS r FROM f;
GRANT SELECT ON f, d TO player, flow;

SELECT ok((SELECT r ->> 'key' FROM d) ~ '^[\w-]+\.[\w-]+\.[\w-]+$', 'running it issues a key');
SELECT is((SELECT count(*) FROM flow_deployment WHERE revoked_at IS NULL)::int, 1,
          'and says where it runs');

-- The process server comes back with the key: what PostgREST would put in
-- request.jwt.claims, and the role it would take.
SELECT set_config('request.jwt.claims', auth.verify(r ->> 'key')::text, true) FROM d;
SET LOCAL ROLE flow;
SELECT is(api.port_write('00000000-0000-0000-0000-0000000195b1', 'on', '"true"'::jsonb)
          ->> 'value', 'true', 'the key switches a lamp on its flow''s land, said in words as a flow says it');
SELECT throws_like($$SELECT api.port_write('00000000-0000-0000-0000-0000000195b2', 'on',
                   'true'::jsonb)$$, '%not your land%', 'and not one on anybody else''s');
SELECT throws_ok($$SELECT * FROM api.flow$$, '42501', NULL, 'it reads no flows');
SELECT ok(api.world_clock() > 0, 'it may ask the time');
RESET ROLE;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
SELECT is((SELECT written_by FROM live_state WHERE port = 'on'), (SELECT ben FROM who),
          'what it wrote is recorded as written by whoever ran it');
SELECT ok(revoke_flow_key((SELECT (r ->> 'id')::uuid FROM d)), 'Stop withdraws the key');

SELECT set_config('request.jwt.claims', auth.verify(r ->> 'key')::text, true) FROM d;
SET LOCAL ROLE flow;
SELECT throws_like($$SELECT api.port_write('00000000-0000-0000-0000-0000000195b1', 'on',
                   'false'::jsonb)$$, '%not your land%', 'and a withdrawn key writes nothing');
RESET ROLE;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', cara, 'role', 'player')::text, true) FROM who;
SELECT throws_like($$SELECT deploy_flow((SELECT id FROM f), (SELECT server FROM f),
    repeat('e', 64), '7', '9')$$, '%may not run flows%',
    'somebody who does not build there cannot run its flows');
SET LOCAL ROLE player;
SELECT is((SELECT count(*) FROM api.flow_deployment)::int, 0,
          'or see where they run');
RESET ROLE;

SELECT finish();
ROLLBACK;
