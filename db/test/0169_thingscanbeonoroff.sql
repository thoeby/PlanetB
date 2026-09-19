-- A placed thing can be told things (db/0169).
BEGIN;
SELECT plan(16);

SET client_min_messages = warning;
SET search_path = api, public;

CREATE TEMP TABLE who AS
SELECT register('lamp169@example.com', 'password12') AS ben,
       register('pass169@example.com', 'password12') AS cara;
GRANT SELECT ON who TO player, admin;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'glb', 10, 'canon-v2'),
       (repeat('b', 64), 'material', 10, 'material-v1');

-- A lamp whose head lights up, and a billboard whose screen shows something:
-- the two markings FND.6 gives a product (db/0160).
INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris,
                   tex_bytes, license, creator_id, type, parts)
SELECT 'SLAMPLAMPLAMP', repeat('a', 64), 2, 'Lampe', 'street',
    '{}'::jsonb, 10, 0, 'cc0', who.ben, 'model',
    jsonb_build_object(
        'parts', jsonb_build_array(
            jsonb_build_object('name', 'head', 'node', 'head', 'role', 'light'),
            jsonb_build_object('name', 'face', 'node', 'face', 'role', 'screen')),
        'ports', jsonb_build_array(
            jsonb_build_object('name', 'on', 'type', 'boolean', 'default', 'false',
                               'drives', jsonb_build_object('part', 'head')),
            jsonb_build_object('name', 'colour', 'type', 'colour',
                               'drives', jsonb_build_object('part', 'head')),
            jsonb_build_object('name', 'image', 'type', 'image', 'default', '',
                               'drives', jsonb_build_object('part', 'face'))))
FROM who;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000169a1'::uuid,
    st_setsrid(st_makeenvelope(7.86, 46.285, 7.864, 46.287), 4326), who.ben, 14
FROM who;

INSERT INTO instance (id, area_id, san, lon, lat)
VALUES ('00000000-0000-0000-0000-0000000169b1'::uuid,
        '00000000-0000-0000-0000-0000000169a1'::uuid, 'SLAMPLAMPLAMP',
        7.862, 46.286);
CREATE TEMP TABLE thing AS
SELECT '00000000-0000-0000-0000-0000000169b1'::uuid AS id;

-- The product says what it can be told, and nobody else does (Invariant 6).
SELECT isnt(port_of('SLAMPLAMPLAMP', 'on'), NULL, 'the lamp has an on port');
SELECT is(port_of('SLAMPLAMPLAMP', 'volume'), NULL,
          'and nothing it was never given');

SELECT is(port_write((SELECT id FROM thing), 'on', 'true'::jsonb) ->> 'value',
          'true', 'the owner switches it on');
SELECT is((SELECT value FROM live_state WHERE port = 'on'), 'true'::jsonb,
          'and the world remembers it');
SELECT ok((SELECT rev FROM live_state WHERE port = 'on') > 0,
          'under a number the page can ask what changed since');

SELECT throws_like(
    $$SELECT port_write((SELECT id FROM thing), 'on', '"yes"'::jsonb)$$,
    '%on or off%', 'a switch is not told a word');
SELECT throws_like(
    $$SELECT port_write((SELECT id FROM thing), 'colour', '"orange"'::jsonb)$$,
    '%not a colour%', 'and a colour is written as #rrggbb');
SELECT throws_like(
    $$SELECT port_write((SELECT id FROM thing), 'volume', '3'::jsonb)$$,
    '%cannot be told%', 'a port the product never declared is refused');

-- D13: a screen is somebody else's advertisement, so it waits.
SELECT is(port_write((SELECT id FROM thing), 'image',
                     to_jsonb(repeat('b', 64))) ->> 'waiting', 'true',
          'a screen is written as something waiting');
SELECT is((SELECT value FROM live_state WHERE port = 'image'), '""'::jsonb,
          'and what everybody sees is what it was');
SELECT throws_like(
    $$SELECT port_write((SELECT id FROM thing), 'image', to_jsonb(repeat('c', 64)))$$,
    '%no picture with that sha256%', 'a screen shows a picture the world holds');

-- What is near where somebody is standing, and what is not.
SELECT is(jsonb_array_length(live_near(7.862, 46.286, 500, 0)), 2,
          'both ports are within sight of the lamp');
SELECT is(jsonb_array_length(live_near(8.5, 46.9, 500, 0)), 0,
          'and none of them from the next valley');
SELECT is(jsonb_array_length(
              live_near(7.862, 46.286, 500,
                        (SELECT max(rev) FROM live_state))), 0,
          'asking again with the last number seen brings nothing back');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', cara, 'role', 'player')::text, true) FROM who;

-- Invariant 6: a lamp is not a thing passers-by switch.
SELECT throws_like(
    $$SELECT port_write((SELECT id FROM thing), 'on', 'false'::jsonb)$$,
    '%not your land%', 'somebody with nothing on the land cannot set it');
SELECT is((SELECT value FROM live_state WHERE port = 'on'), 'true'::jsonb,
          'and the lamp is still on');

SELECT finish();
ROLLBACK;
