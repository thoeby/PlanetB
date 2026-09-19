-- What happened in the world, and the one change that is said yes to (db/0170).
BEGIN;
SELECT plan(13);

SET client_min_messages = warning;
SET search_path = api, public;

CREATE TEMP TABLE who AS
SELECT register('ben170@example.com', 'password12') AS ben,
       register('cara170@example.com', 'password12') AS cara;
GRANT SELECT ON who TO player, admin;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'glb', 10, 'canon-v2'),
       (repeat('b', 64), 'material', 10, 'material-v1');

INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                   tex_bytes, license, creator_id, type, parts)
SELECT 'SBOARDBOARDBB', repeat('a', 64), 2, 'Plakatwand', 'street',
    '{}'::jsonb, 10, 0, 'cc0', who.ben, 'model',
    jsonb_build_object(
        'parts', jsonb_build_array(
            jsonb_build_object('name', 'face', 'node', 'face', 'role', 'screen'),
            jsonb_build_object('name', 'head', 'node', 'head', 'role', 'light')),
        'ports', jsonb_build_array(
            jsonb_build_object('name', 'image', 'type', 'image', 'default', '',
                               'drives', jsonb_build_object('part', 'face')),
            jsonb_build_object('name', 'on', 'type', 'boolean', 'default', 'false',
                               'drives', jsonb_build_object('part', 'head'))))
FROM who;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000170a1'::uuid,
    st_setsrid(st_makeenvelope(7.86, 46.285, 7.864, 46.287), 4326), who.ben, 14
FROM who;
INSERT INTO instance (id, area_id, san, lon, lat)
VALUES ('00000000-0000-0000-0000-0000000170b1'::uuid,
        '00000000-0000-0000-0000-0000000170a1'::uuid, 'SBOARDBOARDBB',
        7.862, 46.286);
CREATE TEMP TABLE thing AS
SELECT '00000000-0000-0000-0000-0000000170b1'::uuid AS id;

-- A port that changed is the world's own doing, written where the change is.
SELECT lives_ok($$SELECT port_write((SELECT id FROM thing), 'on', 'true'::jsonb)$$,
                'the board''s light goes on');
SELECT is((SELECT count(*)::int FROM world_event WHERE kind = 'port_changed'), 1,
          'and the world recorded that it happened');
SELECT is((SELECT data ->> 'port' FROM world_event WHERE kind = 'port_changed'),
          'on', 'saying which port it was');

-- The page records what only it saw, at most one a second per thing.
SELECT isnt(record_event('click', (SELECT id FROM thing)), NULL,
            'a click on it is recorded');
SELECT is(record_event('click', (SELECT id FROM thing)), NULL,
          'and a second click in the same second is not');
SELECT throws_like($$SELECT record_event('port_changed', (SELECT id FROM thing))$$,
    '%not "port_changed"%', 'a page does not get to say a port changed');

-- D13: a screen waits, is listed where the land is submitted, and is said yes
-- to by the land's approver — and that opens no job.
SELECT lives_ok(
    $$SELECT port_write((SELECT id FROM thing), 'image', to_jsonb(repeat('b', 64)))$$,
    'the screen is given a picture');
SELECT is(submission_changes('00000000-0000-0000-0000-0000000170a1'::uuid)
          ->> 'screens', '1', 'Submit counts it with everything else that changed');
SELECT is(jsonb_array_length(screens_waiting()), 1,
          'and it is waiting for the person who decides');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', cara, 'role', 'player')::text, true) FROM who;
SELECT is(jsonb_array_length(screens_waiting()), 0,
          'somebody who decides nothing here is shown nothing');
SELECT throws_like(
    $$SELECT approve_screen((SELECT id FROM thing), 'image')$$,
    '%not yours to approve%', 'and cannot say yes to it');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
SELECT is(approve_screen((SELECT id FROM thing), 'image') ->> 'value',
          repeat('b', 64), 'the approver says yes and the world shows it');
SELECT is((SELECT count(*)::int FROM job), 0,
          'nothing baked changed, so nothing is compiled again');

SELECT finish();
ROLLBACK;
