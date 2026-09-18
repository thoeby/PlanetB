-- A render somebody walked away from (db/0079_worktakenandgivenback.sql).
BEGIN;
SELECT plan(6);

CREATE TEMP TABLE who AS
SELECT register('cara79@example.com', 'password12') AS cara,
       register('dan79@example.com', 'password12') AS dan;
GRANT SELECT ON who TO player;

SET LOCAL role = 'postgres';
INSERT INTO area (id, geom, owner_id, detail, rules)
SELECT '00000000-0000-0000-0000-0000000000d1'::uuid,
       st_makeenvelope(7.70, 46.70, 7.71, 46.71, 4326), cara, 14,
       '{"name": "the pool field"}'::jsonb
FROM who;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000d1', 'landuse',
        st_force3d(st_makeenvelope(7.702, 46.702, 7.706, 46.706, 4326)));
SET LOCAL role = 'player';

SELECT set_config('request.jwt.claims',
    json_build_object('sub', cara, 'role', 'player')::text, true) FROM who;

CREATE TEMP TABLE jid AS
SELECT ensure_job(t.z, t.x, t.y) AS id
FROM tile t WHERE t.z = 14 AND t.dirty
  AND st_intersects(st_makeenvelope(7.70, 46.70, 7.71, 46.71, 4326),
                    tile_bbox(t.z, t.x, t.y))
ORDER BY t.z, t.x, t.y
LIMIT 1;
GRANT SELECT ON jid TO player;

CREATE TEMP TABLE took AS
SELECT (claim_for((SELECT id FROM jid), '{}'::jsonb)).id AS atom;
GRANT SELECT ON took TO player;

SELECT isnt((SELECT atom FROM took), null, 'Cara has a piece of it in hand');
SELECT is((SELECT (j ->> 'claimed')::int FROM jsonb_array_elements(render_pool()) j
           WHERE (j ->> 'job')::bigint = (SELECT id FROM jid)),
          1, 'and the pool says so');

-- Somebody else may not take it out of her hands.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', dan, 'role', 'player')::text, true) FROM who;
SELECT throws_ok($$SELECT hand_back_atom((SELECT atom FROM took))$$,
    '42501', null, 'nobody else gives back work they are not doing');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', cara, 'role', 'player')::text, true) FROM who;
SELECT ok(hand_back_atom((SELECT atom FROM took)),
          'the tab that has it gives it back on its way out');
SELECT is((SELECT state FROM atom WHERE id = (SELECT atom FROM took)), 'ready',
          'and it is work again, with no attempt spent on it');
SELECT is((SELECT (j ->> 'handed_back')::int
           FROM jsonb_array_elements(render_pool()) j
           WHERE (j ->> 'job')::bigint = (SELECT id FROM jid)),
          1, 'the pool says what happened to it');

SELECT * FROM finish();
ROLLBACK;
