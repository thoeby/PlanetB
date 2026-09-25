-- What the interact blocks ask the world (db/0204).
BEGIN;
SELECT plan(9);

SET client_min_messages = warning;
SET search_path = api, public;

CREATE TEMP TABLE who AS
SELECT register('gate201@example.com', 'password12') AS ben,
       register('walk201@example.com', 'password12') AS dora;
GRANT SELECT ON who TO player, admin, flow;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'glb', 10, 'canon-v2');
INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                   tex_bytes, license, creator_id, type, parts)
SELECT 'SGATEGATEGATE', repeat('a', 64), 2, 'Tor', 'prop', '{}'::jsonb, 10, 0,
    'cc0', who.ben, 'model',
    '{"triggers": [{"kind": "near", "params": {"m": 5}}, {"kind": "click"}]}'::jsonb
FROM who;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000201a1'::uuid,
    st_setsrid(st_makeenvelope(7.86, 46.285, 7.864, 46.287), 4326), who.ben, 14
FROM who;
INSERT INTO instance (id, area_id, san, lon, lat)
VALUES ('00000000-0000-0000-0000-0000000201b1'::uuid,
        '00000000-0000-0000-0000-0000000201a1'::uuid, 'SGATEGATEGATE', 7.862, 46.286);
CREATE TEMP TABLE thing AS SELECT '00000000-0000-0000-0000-0000000201b1'::uuid AS id;
GRANT SELECT ON thing TO player, admin, flow;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', dora, 'role', 'player')::text, true) FROM who;
CREATE TEMP TABLE fired AS
SELECT emit_trigger((SELECT id FROM thing), 'click') AS c,
       emit_trigger((SELECT id FROM thing), 'near') AS n;
GRANT SELECT ON fired TO player, admin, flow;
SELECT throws_like($$SELECT triggers_since(0, (SELECT id FROM thing), 'near')$$,
    '%not yours to read%', 'a passer-by does not read the land''s firings');
SELECT throws_like($$SELECT post_note((SELECT id FROM thing), 'hello')$$,
    '%not your land%', 'nor makes somebody else''s gate speak');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
SELECT is(triggers_since(0, (SELECT id FROM thing), 'near') ->> 'fired', 'true',
          'the owner is told it was walked up to');
SELECT is(jsonb_array_length(triggers_since(0, (SELECT id FROM thing), 'near') -> 'events'), 1,
          'once, and not the click beside it');
SELECT is(triggers_since((SELECT n FROM fired), (SELECT id FROM thing), 'near') ->> 'fired',
          'false', 'and after that event, nothing more');
SELECT is((triggers_since(0, (SELECT id FROM thing), 'near') -> 'events' -> 0 ->> 'player_id')::uuid,
          (SELECT dora FROM who), 'with who it was, to give things to');

SELECT ok(post_note((SELECT id FROM thing), 'Willkommen') > 0, 'the owner makes the gate speak');
SELECT is(notes_near(7.862, 46.286, 200, 0) -> 0 ->> 'text', 'Willkommen',
          'and whoever stands near reads it');
SELECT throws_like($$SELECT post_note((SELECT id FROM thing), '')$$,
    '%between 1 and 200%', 'a note says something');

SELECT * FROM finish();
ROLLBACK;
