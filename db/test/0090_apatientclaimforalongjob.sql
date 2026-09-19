-- A claim is left alone for as long as the work on it deserves. Five minutes is
-- right for a sample and wrong for a train: a tab that is still training loses
-- the whole thing, and three of those mark the atom failed for good.
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

SELECT is(claim_patience('sample'), interval '5 minutes',
    'a sample is seconds of arithmetic and waits the old five minutes');
SELECT is(claim_patience('merge'), interval '5 minutes', 'and so does a merge');
SELECT cmp_ok(claim_patience('train'), '>', interval '5 minutes',
    'a train is minutes of GPU and waits longer');

CREATE TEMP TABLE ids AS
SELECT register('own90@example.com', 'password12') AS owner_id,
       register('rnd90@example.com', 'password12') AS worker_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000090'::uuid,
       st_geomfromtext('POLYGON((7.875 46.290,7.885 46.290,7.885 46.297,'
                       '7.875 46.297,7.875 46.290))', 4326),
       ids.owner_id, 18
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000090', 'building',
        st_force3d(st_geomfromtext('POLYGON((7.8770 46.2915,7.8772 46.2915,'
                                   '7.8772 46.2917,7.8770 46.2917,'
                                   '7.8770 46.2915))', 4326)));

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job(18, tile_x(7.8771, 18), tile_y(46.2916, 18)) AS jid;

-- Both kinds of atom, claimed and then silent for eight minutes: long enough
-- that the old rule would have taken them both.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', worker_id, 'role', 'player')::text, true) FROM ids;
-- The train waits on its frames, and waiting is not claimable
-- (db/0005_state.sql), so it is made ready before it is taken.
UPDATE atom SET state = 'ready'
WHERE job_id = (SELECT jid FROM jobs) AND op IN ('train', 'assemble')
  AND state = 'waiting';
UPDATE atom SET state = 'claimed', worker_id = my_worker(null),
                claimed_at = now() - interval '8 minutes',
                heartbeat_at = now() - interval '8 minutes'
WHERE job_id = (SELECT jid FROM jobs) AND op IN ('train', 'assemble');

SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = (SELECT jid FROM jobs) AND state = 'claimed'), 2,
    'two atoms are in a tab''s hands and have not beaten for eight minutes');

SELECT lives_ok($$SELECT expire_claims()$$, 'the backstop runs');

SELECT results_eq(
    $$SELECT op, state FROM atom
      WHERE job_id = (SELECT jid FROM jobs) AND op IN ('assemble', 'train')
      ORDER BY op$$,
    $$VALUES ('assemble', 'ready'), ('train', 'claimed')$$,
    'the assemble is taken back and the train is left to get on with it');

ROLLBACK;
