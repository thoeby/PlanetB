-- Helping render the world: what a background tab may claim, in what order,
-- and what the dashboard says about it (db/0024_progress.sql).
BEGIN;
SELECT plan(12);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('bg-worker@example.com', 'password12') AS worker_id,
       register('bg-owner@example.com', 'password12') AS owner_id;
GRANT SELECT ON ids TO player;

-- Nothing else in the world may be claimed ahead of the fixtures: claim_atom
-- picks globally (db/0005_state.sql).
UPDATE atom SET state = 'waiting' WHERE state = 'ready';

-- Three tiles in a row at z14, a job each, one atom each. The middle one is
-- 8.05 E; the others are its neighbours west and far east.
INSERT INTO tile (z, x, y, dirty, expected_version)
VALUES (14, 8500, 5700, true, 1), (14, 8501, 5700, true, 1), (14, 8900, 5700, true, 1);

INSERT INTO job (id, z, x, y, target_version, state, bounty) VALUES
(900001, 14, 8500, 5700, 1, 'open', 0),
(900002, 14, 8501, 5700, 1, 'open', 0),
(900003, 14, 8900, 5700, 1, 'open', 0),
(900004, 14, 8900, 5700, 2, 'open', 5);

INSERT INTO atom (id, job_id, atom_hash, op, algo_version, inputs, params, seed, state)
VALUES
(900001, 900001, repeat('1', 64), 'merge', 'merge-v1', '{}', '{}', 1, 'ready'),
(900002, 900002, repeat('2', 64), 'sample', 'sample-v1', '{}', '{}', 1, 'ready'),
(900003, 900003, repeat('3', 64), 'sog', 'sog-v1', '{}', '{}', 1, 'ready'),
(900004, 900004, repeat('4', 64), 'sog', 'sog-v1', '{}', '{}', 1, 'ready'),
(900005, 900003, repeat('5', 64), 'train', 'train-v1',
 '{}', '{"needs_webgpu": false}', 1, 'ready');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', worker_id, 'role', 'player')::text, true) FROM ids;

-- ------------------------------------------------------------------- caps

-- The far tile carries the only bounty, so it goes first however near the
-- others are: background rendering fills gaps, it does not starve paid work.
CREATE TEMP TABLE c1 AS
SELECT * FROM claim_atom(jsonb_build_object(
    'ops', jsonb_build_array('merge', 'sample', 'sog'),
    'near', jsonb_build_object('lon', 8.0, 'lat', 47.0)));
SELECT is((SELECT id FROM c1), 900004::bigint, 'a bounty is claimed before anything near');

-- With the paid one gone, the nearest of the rest wins. Tile 8500/5700 is at
-- about 7.03 E; 8501 is just east of it; 8900 is far away.
CREATE TEMP TABLE near1 AS
SELECT st_x(st_centroid(tile_bbox(14, 8500, 5700))) AS lon,
       st_y(st_centroid(tile_bbox(14, 8500, 5700))) AS lat;
CREATE TEMP TABLE c2 AS
SELECT * FROM claim_atom(jsonb_build_object(
    'ops', jsonb_build_array('merge', 'sample', 'sog'),
    'near', (SELECT jsonb_build_object('lon', lon, 'lat', lat) FROM near1)));
SELECT is((SELECT id FROM c2), 900001::bigint, 'then the nearest unbountied atom');

CREATE TEMP TABLE c3 AS
SELECT * FROM claim_atom(jsonb_build_object(
    'ops', jsonb_build_array('merge', 'sample', 'sog'),
    'near', (SELECT jsonb_build_object('lon', lon, 'lat', lat) FROM near1)));
SELECT is((SELECT id FROM c3), 900002::bigint, 'then the next nearest');

-- `ops` is a filter, not a preference: a train atom is never background work.
CREATE TEMP TABLE c4 AS
SELECT * FROM claim_atom(jsonb_build_object(
    'ops', jsonb_build_array('merge', 'sample', 'sog')));
SELECT is((SELECT id FROM c4), 900003::bigint, 'only the named ops are claimed');
SELECT is((SELECT count(*)::int FROM atom WHERE id = 900005 AND state = 'ready'), 1,
          'and the train atom is left alone');

-- Without `ops` the same caller takes it, so nothing was hidden, only filtered.
CREATE TEMP TABLE c5 AS SELECT * FROM claim_atom('{}'::jsonb);
SELECT is((SELECT id FROM c5), 900005::bigint, 'an unfiltered claim still gets it');

-- Without `near` the order is the old one: bounty, then id (WP0.6).
SELECT lives_ok($$SELECT claim_atom('{"ops": ["merge"]}'::jsonb)$$,
                'a claim with no position is still a claim');

-- --------------------------------------------------------------- progress

SELECT ok((SELECT count(*) FROM progress) > 0, 'the dashboard has a row per zoom');
SELECT is((SELECT tiles::int FROM progress WHERE z = 14),
          (SELECT count(*)::int FROM tile WHERE z = 14),
          'it counts every tile at that zoom');
SELECT is((SELECT dirty::int FROM progress WHERE z = 14),
          (SELECT count(*)::int FROM tile WHERE z = 14 AND dirty),
          'and how many are waiting to be drawn');
SELECT is((SELECT jobs_open::int FROM progress WHERE z = 14),
          (SELECT count(*)::int FROM job WHERE z = 14 AND state = 'open'),
          'and how many jobs are open');
SELECT is((SELECT atoms_claimed::int FROM progress WHERE z = 14),
          (SELECT count(*)::int FROM atom a INNER JOIN job j ON j.id = a.job_id
           WHERE j.z = 14 AND a.state = 'claimed'),
          'and what is in hand right now');

SELECT * FROM finish();
ROLLBACK;
