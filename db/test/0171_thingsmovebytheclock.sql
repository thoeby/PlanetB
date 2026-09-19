-- A thing that moves by the world's own clock (db/0171, db/0172).
BEGIN;
SELECT plan(14);

SET client_min_messages = warning;
SET search_path = api, public;

CREATE TEMP TABLE who AS
SELECT register('ben171@example.com', 'password12') AS ben,
       register('cara171@example.com', 'password12') AS cara;
GRANT SELECT ON who TO player, admin;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'glb', 10, 'canon-v2');

INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                   tex_bytes, license, creator_id, type)
SELECT 'SBUSBUSBUSBUS', repeat('a', 64), 2, 'Postauto', 'vehicle',
    '{}'::jsonb, 10, 0, 'cc0', who.ben, 'model'
FROM who;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000171a1'::uuid,
    st_setsrid(st_makeenvelope(7.86, 46.285, 7.864, 46.287), 4326), who.ben, 14
FROM who;
CREATE TEMP TABLE land AS
SELECT '00000000-0000-0000-0000-0000000171a1'::uuid AS id;

-- A route inside the land, and a timetable somebody typed.
CREATE TEMP TABLE route AS SELECT '{"type": "LineString",
    "coordinates": [[7.861, 46.2855], [7.863, 46.2855]]}'::jsonb AS ok,
    '{"type": "LineString",
      "coordinates": [[7.861, 46.2855], [7.9, 46.2855]]}'::jsonb AS away;

CREATE TEMP TABLE made AS
SELECT mover_set(null, jsonb_build_object(
    'area', (SELECT id FROM land), 'san', 'SBUSBUSBUSBUS', 'name', 'Bus 1',
    'route', (SELECT ok FROM route), 'speed_kmh', 30,
    'schedule', '{"every_s": 300, "loop": "circle",
                  "dwell": [{"at_m": 80, "s": 20}]}'::jsonb)) AS it;

SELECT is(it ->> 'name', 'Bus 1', 'a bus is put on a route') FROM made;
SELECT is((it ->> 'speed_kmh')::numeric, 30::numeric, 'at the speed it was given')
FROM made;
SELECT is(jsonb_array_length(it -> 'route'), 2,
          'and the page is handed the line as points') FROM made;
SELECT is(it ->> 'sha256', repeat('a', 64),
          'with the digest of what it looks like') FROM made;

-- Nothing about a mover is compiled: it is not on the land, it moves over it.
SELECT is((SELECT count(*)::int FROM job), 0, 'no job was opened for it');
SELECT is((SELECT count(*)::int FROM tile WHERE dirty), 0, 'and no tile is dirty');

-- Invariant 6: where a bus may go is the land's to say.
SELECT throws_like($$SELECT mover_set(null, jsonb_build_object(
    'area', (SELECT id FROM land), 'san', 'SBUSBUSBUSBUS',
    'route', (SELECT away FROM route)))$$,
    '%leaves the land%', 'a route out of the land is refused');
SELECT throws_like($$SELECT mover_set(null, jsonb_build_object(
    'area', (SELECT id FROM land), 'san', 'SBUSBUSBUSBUS',
    'route', (SELECT ok FROM route),
    'schedule', '{"loop": "zigzag"}'::jsonb))$$,
    '%comes round again%', 'and so is a timetable nobody can read');

-- Pausing it, and putting it back on the road.
SELECT is(mover_set((SELECT (it ->> 'id')::uuid FROM made),
                    '{"paused": true}'::jsonb) ->> 'paused', 'true',
          'it is stopped where it is');
SELECT is(mover_set((SELECT (it ->> 'id')::uuid FROM made),
                    '{"paused": false}'::jsonb) ->> 'paused', 'false',
          'and started again');

-- What is near, and what is on which land.
SELECT is(jsonb_array_length(movers_near(7.862, 46.2855, 2000)), 1,
          'a player standing there is handed it');
SELECT is(jsonb_array_length(movers_near(8.5, 46.9, 2000)), 0,
          'and one in the next valley is not');
SELECT is(jsonb_array_length(movers_on((SELECT id FROM land))), 1,
          'the land knows what runs on it');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', cara, 'role', 'player')::text, true) FROM who;
SELECT throws_like(
    $$SELECT mover_set((SELECT (it ->> 'id')::uuid FROM made), '{"paused": true}'::jsonb)$$,
    '%not your land%', 'somebody with nothing on the land cannot stop it');

SELECT finish();
ROLLBACK;
