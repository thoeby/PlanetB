-- Asking to build on somebody else's land (db/0076_askingforagrant.sql): the
-- ask, who sees it, and what giving it does.
BEGIN;
SELECT plan(9);

CREATE TEMP TABLE who AS
SELECT register('ben76@example.com', 'password12') AS ben,
       register('cara76@example.com', 'password12') AS cara;
-- PLAN-identity.md: these players are verified people (db/0195).
INSERT INTO player_verification (player_id, state, method, how)
SELECT id, 'verified', 'manual', 'fixture' FROM auth.user ON CONFLICT DO NOTHING;
GRANT SELECT ON who TO player;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
SELECT set_my_name('Ben');
INSERT INTO area (id, geom, owner_id, detail, rules)
SELECT '00000000-0000-0000-0000-0000000000f1'::uuid,
       st_makeenvelope(7.50, 46.50, 7.51, 46.51, 4326), ben, 14,
       '{"name": "Ben''s field"}'::jsonb
FROM who;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', cara, 'role', 'player')::text, true) FROM who;
SELECT set_my_name('Cara');

SELECT ok(NOT is_area_writer('00000000-0000-0000-0000-0000000000f1'),
          'Cara may not build on Ben''s land');
CREATE TEMP TABLE ask AS
SELECT request_grant('00000000-0000-0000-0000-0000000000f1', 'direct_edit',
                     'a bench by the path') AS r;
GRANT SELECT ON ask TO player;
SELECT is((SELECT r ->> 'state' FROM ask), 'open', 'the ask is waiting');
SELECT is((SELECT count(*) FROM jsonb_array_elements(grant_requests(null))),
          1::bigint, 'and the asker can see their own');
SELECT throws_like(
    $$SELECT give_grant((SELECT (r ->> 'id')::uuid FROM ask))$$,
    '%only the owner%', 'but cannot answer it themselves');

-- Ben was told, in words that say who and what.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', ben, 'role', 'player')::text, true) FROM who;
SELECT ok((SELECT count(*) > 0 FROM jsonb_array_elements(my_notifications(true)) n
           WHERE n ->> 'words' LIKE '%Cara asked to build on%'),
          'and the owner is told who asked and for what');
SELECT is((SELECT e ->> 'note' FROM jsonb_array_elements(
               grant_requests('00000000-0000-0000-0000-0000000000f1')) e),
          'a bench by the path', 'the note is on the ask');

CREATE TEMP TABLE gave AS
SELECT give_grant((SELECT (r ->> 'id')::uuid FROM ask)) AS g;
SELECT is((SELECT g ->> 'state' FROM gave), 'given', 'the owner gives it');
SELECT is(grant_requests('00000000-0000-0000-0000-0000000000f1'), '[]'::jsonb,
          'and it is no longer waiting');

-- And now Cara may build there, by the same rule the browser and QGIS read.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', cara, 'role', 'player')::text, true) FROM who;
SELECT ok(is_area_writer('00000000-0000-0000-0000-0000000000f1'),
          'Cara may build on it now');

SELECT * FROM finish();
ROLLBACK;
