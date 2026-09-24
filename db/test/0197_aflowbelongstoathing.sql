-- A flow may belong to one placed thing on its land (db/0197).
BEGIN;
SELECT plan(7);

SET client_min_messages = warning;

CREATE TEMP TABLE who AS
SELECT register('thing194@example.com', 'password12') AS ben;
GRANT SELECT ON who TO player;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'glb', 10, 'canon-v2');
SELECT register_artifact(repeat('e', 64), 'flow', 120, 'elx-v1');
INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                   tex_bytes, license, creator_id, type, parts)
SELECT 'SLAMPTHINGAAB', repeat('a', 64), 2, 'Lampe', 'street', '{}'::jsonb, 10, 0,
       'cc0', who.ben, 'model', '{}'::jsonb
FROM who;
INSERT INTO area (id, geom, owner_id, detail, rules)
SELECT a.id, st_setsrid(a.env, 4326), who.ben, 14, jsonb_build_object('name', a.nm)
FROM who, (VALUES
    ('00000000-0000-0000-0000-0000000194a1'::uuid,
     st_makeenvelope(7.86, 46.285, 7.864, 46.287), 'Feld'),
    ('00000000-0000-0000-0000-0000000194a2'::uuid,
     st_makeenvelope(7.87, 46.285, 7.874, 46.287), 'Wald')) AS a (id, env, nm);
INSERT INTO instance (id, area_id, san, lon, lat)
VALUES ('00000000-0000-0000-0000-0000000194b1'::uuid,
        '00000000-0000-0000-0000-0000000194a1'::uuid, 'SLAMPTHINGAAB', 7.862, 46.286);

CREATE TEMP TABLE saved AS
SELECT save_flow(null, '00000000-0000-0000-0000-0000000194a1', 'Lamp at dusk',
                 repeat('e', 64), '{}'::jsonb, 0,
                 '00000000-0000-0000-0000-0000000194b1') AS r;

SELECT is((SELECT instance_id FROM flow WHERE name = 'Lamp at dusk'),
          '00000000-0000-0000-0000-0000000194b1'::uuid, 'a flow belongs to the lamp');

SELECT lives_ok($$SELECT save_flow((SELECT (r ->> 'id')::uuid FROM saved),
    '00000000-0000-0000-0000-0000000194a1', 'Lamp at night', repeat('e', 64),
    '{}'::jsonb, 1)$$, 'renaming it the old way');
SELECT is((SELECT instance_id FROM flow WHERE name = 'Lamp at night'),
          '00000000-0000-0000-0000-0000000194b1'::uuid, 'does not take it off the lamp');

SELECT throws_like($$SELECT save_flow(null, '00000000-0000-0000-0000-0000000194a2',
    'Elsewhere', repeat('e', 64), '{}'::jsonb, 0,
    '00000000-0000-0000-0000-0000000194b1')$$,
    'Lampe is not on Wald.', 'a flow belongs only to a thing on its own land');

SELECT lives_ok($$SELECT save_flow((SELECT (r ->> 'id')::uuid FROM saved),
    '00000000-0000-0000-0000-0000000194a1', 'Lamp at night', repeat('e', 64),
    '{}'::jsonb, 2, null)$$, 'detaching it');
SELECT is((SELECT instance_id FROM flow WHERE name = 'Lamp at night'), null,
          'leaves it on the land, belonging to nothing');

SELECT has_column('api'::name, 'flow'::name, 'instance_id'::name,
                  'and the API says which thing a flow is on');

SELECT finish();
ROLLBACK;
