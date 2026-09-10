-- A verdict enters only through a check the caller holds or a spot check the
-- server asked for, and counts once per verifier (db/0027_verifyguard.sql).
BEGIN;
SELECT plan(10);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role)
SELECT ('00000000-0000-0000-0000-00000000c00' || n)::uuid,
       'guard-' || n || '@example.com', 'x', 'player'
FROM generate_series(1, 4) AS n;
INSERT INTO account (owner_id)
SELECT ('00000000-0000-0000-0000-00000000c00' || n)::uuid FROM generate_series(1, 4) AS n;
INSERT INTO worker (id, user_id, caps, trust)
SELECT ('00000000-0000-0000-0000-00000000d00' || n)::uuid,
       ('00000000-0000-0000-0000-00000000c00' || n)::uuid, '{}', 0.8
FROM generate_series(1, 4) AS n;

CREATE FUNCTION as_user(n int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
        json_build_object('sub', '00000000-0000-0000-0000-00000000c00' || n,
                          'role', 'player')::text);
END
$$;

-- claim_atom picks globally; nothing else may be ready while this runs.
UPDATE atom SET state = 'waiting' WHERE state = 'ready';

-- A trained tile with its sog submitted: user 1 trained, user 2 encoded.
INSERT INTO tile (z, x, y, dirty, expected_version) VALUES (16, 40007, 30007, true, 1);
INSERT INTO job (id, z, x, y, target_version, state)
VALUES (927001, 16, 40007, 30007, 1, 'open');
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('e', 64), 'sog', 5000, 'sog-v1');
INSERT INTO atom (id, job_id, atom_hash, op, algo_version, params, state, worker_id)
VALUES (927001, 927001, repeat('1', 64), 'train', 'train-v1', '{}'::jsonb, 'verified',
        '00000000-0000-0000-0000-00000000d001');
INSERT INTO atom (id, job_id, atom_hash, op, algo_version, params, deps, state,
                  worker_id, output_sha256, result)
VALUES (927002, 927001, repeat('2', 64), 'sog', 'sog-v1', '{}'::jsonb, ARRAY[927001],
        'submitted', '00000000-0000-0000-0000-00000000d002', repeat('e', 64),
        '{"manifest": {"splats": 10, "origin": {"lon": 8, "lat": 47, "h": 400}}}'::jsonb);
INSERT INTO atom (id, job_id, atom_hash, op, algo_version, params, deps, inputs, state)
SELECT 927002 + n, 927001, repeat((2 + n)::text, 64), 'verify', 'verify-v1',
       jsonb_build_object('index', n), ARRAY[927002], '{"sog": 927002}'::jsonb, 'ready'
FROM generate_series(1, 3) AS n;

-- ------------------------------------------------------------- the guard

SELECT as_user(3);
SELECT throws_ok('SELECT api.submit_verification(927002, true)', '42501', null,
                 'a tab that holds no check of the sog has no say');
SELECT throws_ok('SELECT api.submit_verification(927002, true, ''{}'', true)', '42501',
                 null, 'nor does it as a spot check nobody asked for');
SELECT ok(NOT has_function_privilege('player',
          'submit_verification(bigint, boolean, jsonb, boolean)', 'EXECUTE'),
          'and the public function is not reachable from a client at all');

CREATE TEMP TABLE c3 AS SELECT * FROM claim_atom('{}'::jsonb);
SELECT is((SELECT op FROM c3), 'verify', 'the tab claims a check');
SELECT is(api.submit_verification(927002, true, '{"psnr": 30}'::jsonb), 'submitted',
          'and may then answer');

-- ------------------------------------------------------ one verdict each

SELECT is((SELECT trust FROM worker WHERE id = '00000000-0000-0000-0000-00000000d001'),
          0.85::numeric(4, 3), 'the trainer is credited for the pass');
SELECT is(api.submit_verification(927002, true, '{"psnr": 31}'::jsonb), 'submitted',
          'saying it again is accepted');
SELECT is((SELECT trust FROM worker WHERE id = '00000000-0000-0000-0000-00000000d001'),
          0.85::numeric(4, 3), 'but moves nothing a second time');
SELECT is((SELECT ok FROM worker_op_stats
           WHERE worker_id = '00000000-0000-0000-0000-00000000d003' AND op = 'verify'), 1,
          'and the verifier is counted once');
SELECT is((SELECT count(*)::int FROM verification
           WHERE atom_id = 927002 AND kind = 'perceptual'), 1,
          'one row per verifier, the latest word in it');

SELECT * FROM finish();
ROLLBACK;
