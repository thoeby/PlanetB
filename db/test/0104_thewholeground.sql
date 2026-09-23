-- Choosing a ground renders all of it at z14, whether or not anybody owns the
-- land (db/0104_thewholeground.sql).
BEGIN;
SELECT plan(7);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('whole@example.com', 'password12') AS uid;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'admin')::text, true) FROM ids;

-- A ground a little bigger than one z14 tile, so it touches four.
CREATE TEMP TABLE g AS
SELECT set_ground('http://gs', 'dem', 7.80, 46.28, 7.83, 46.30) AS out;

SELECT ok((SELECT (out ->> 'dirtied')::int FROM g) >= 4,
    'every z14 tile of the ground has a job (db/0108: none came out before)');
SELECT is((SELECT count(*)::int FROM job WHERE z = 14 AND state = 'open'),
    (SELECT (out ->> 'dirtied')::int FROM g), 'and each is open');
SELECT ok((SELECT count(*) FROM tile WHERE z = 6) >= 1, 'the ladder above them exists');
SELECT is((SELECT count(*)::int FROM atom a INNER JOIN job j ON j.id = a.job_id
           WHERE j.z = 14 AND a.op = 'sample'), 0, 'nothing is sampled any more');
SELECT ok((SELECT count(*) FROM atom a INNER JOIN job j ON j.id = a.job_id
           WHERE j.z = 14 AND a.op = 'train' AND (a.params ->> 'iters')::int = 4000) >= 4,
    'a z14 tile trains, at 1200 steps (db/0122)');
SELECT is((SELECT min(algo_version) FROM atom WHERE op = 'dataset'), 'dataset-v5',
    'from dataset-v4 frames (db/0183)');

-- Asking again builds the same tiles again, no more and no fewer.
SELECT is(compile_ground(), (SELECT (out ->> 'dirtied')::int FROM g),
    'compiling again counts the same tiles');

SELECT * FROM finish();
ROLLBACK;
