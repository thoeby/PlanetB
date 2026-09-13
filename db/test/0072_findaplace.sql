-- Finding a place by name (db/0072_findaplace.sql): the map's search box, for
-- somebody who was told where to go rather than sent a link.
BEGIN;
SELECT plan(7);

CREATE TEMP TABLE who AS
SELECT register('anna72@example.com', 'password12') AS anna,
       register('ben72@example.com', 'password12') AS ben;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', anna, 'role', 'player')::text, true) FROM who;
SELECT set_my_name('Anna');
INSERT INTO area (geom, owner_id, detail, rules)
SELECT st_makeenvelope(7.50, 46.50, 7.51, 46.51, 4326), anna, 14,
       '{"name": "The orchard"}'::jsonb
FROM who;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
SELECT set_my_name('Ben');
INSERT INTO area (geom, owner_id, detail, rules)
SELECT st_makeenvelope(7.60, 46.60, 7.61, 46.61, 4326), ben, 14,
       '{"name": "Ben''s field"}'::jsonb
FROM who;

SELECT is((SELECT count(*) FROM jsonb_array_elements(find_places('orchard'))),
          1::bigint, 'a land is found by its name, whatever the case');
SELECT is((SELECT e ->> 'owner' FROM jsonb_array_elements(find_places('orchard')) e),
          'Anna', 'and it says whose it is');
SELECT is((SELECT count(*) FROM jsonb_array_elements(find_places('Anna'))),
          1::bigint, 'and by the name of the person who owns it');
SELECT ok((SELECT (e ->> 'lon')::numeric BETWEEN 7.50 AND 7.51
           FROM jsonb_array_elements(find_places('Anna')) e),
          'with a point on it to go to');
SELECT is(find_places(''), '[]'::jsonb, 'an empty search finds nothing');
SELECT is(find_places('nowhere at all'), '[]'::jsonb,
          'and so does a name nobody has');

-- Nobody has to be signed in to find a place: what the world holds is public
-- (db/0003_rls.sql), and a visitor following a name is not signed in yet.
SELECT set_config('request.jwt.claims', '', true);
SET LOCAL ROLE anon;
SELECT is((SELECT count(*) FROM jsonb_array_elements(find_places('Ben'))),
          1::bigint, 'a visitor who has not signed in can find one too');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
