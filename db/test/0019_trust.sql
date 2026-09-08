-- What the world thinks of a worker, and what it lets them do about it
-- (db/0019_trust.sql).
BEGIN;
SELECT plan(20);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role)
SELECT ('00000000-0000-0000-0000-00000000a00' || n)::uuid,
       'trust-' || n || '@example.com', 'x', 'player'
FROM generate_series(1, 4) AS n;
INSERT INTO account (owner_id)
SELECT ('00000000-0000-0000-0000-00000000a00' || n)::uuid FROM generate_series(1, 4) AS n;

-- 1 has never done anything, 2 is established, 3 is in disgrace, 4 is trusted
-- to the point of not needing three opinions.
INSERT INTO worker (id, user_id, caps, trust) VALUES
('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000a001', '{}', 0.5),
('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-00000000a002', '{}', 0.8),
('00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-00000000a003', '{}', 0.1),
('00000000-0000-0000-0000-00000000b004', '00000000-0000-0000-0000-00000000a004', '{}', 0.97);

CREATE FUNCTION as_user(n int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
        json_build_object('sub', '00000000-0000-0000-0000-00000000a00' || n,
                          'role', 'player')::text);
END
$$;

SELECT is(trust_min('train'), 0.3::numeric, 'training needs some standing');
SELECT is(trust_min('verify'), 0.6::numeric, 'judging needs more');
SELECT is(trust_min('merge'), 0::numeric, 'and ordinary work needs none');

-- ------------------------------------------------------------------ credit

SELECT credit('00000000-0000-0000-0000-00000000b003', -1);
SELECT is((SELECT trust FROM worker WHERE id = '00000000-0000-0000-0000-00000000b003'),
          0::numeric(4, 3), 'trust does not go below nothing');
SELECT credit('00000000-0000-0000-0000-00000000b004', 1);
SELECT is((SELECT trust FROM worker WHERE id = '00000000-0000-0000-0000-00000000b004'),
          1::numeric(4, 3), 'nor above everything');
UPDATE worker SET trust = 0.1 WHERE id = '00000000-0000-0000-0000-00000000b003';
UPDATE worker SET trust = 0.97 WHERE id = '00000000-0000-0000-0000-00000000b004';

-- --------------------------------------------------------------- the gates

UPDATE atom SET state = 'waiting' WHERE state = 'ready';
INSERT INTO tile (z, x, y, dirty, expected_version) VALUES (16, 41001, 31001, true, 1);
INSERT INTO job (id, z, x, y, target_version, state)
VALUES (940001, 16, 41001, 31001, 1, 'open');
INSERT INTO atom (id, job_id, atom_hash, op, algo_version, params, state) VALUES
(940001, 940001, repeat('7', 64), 'train', 'train-v1', '{}'::jsonb, 'ready'),
(940002, 940001, repeat('8', 64), 'verify', 'verify-v1',
 '{"index": 1, "camera_set": "z16-v1"}'::jsonb, 'waiting'),
(940005, 940001, repeat('5', 64), 'verify', 'verify-v1',
 '{"index": 2, "camera_set": "z16-v1"}'::jsonb, 'waiting'),
(940006, 940001, repeat('4', 64), 'verify', 'verify-v1',
 '{"index": 3, "camera_set": "z16-v1"}'::jsonb, 'waiting');

SELECT as_user(3);
SELECT is((SELECT (claim_atom('{}'::jsonb)).op), null,
          'a worker in disgrace is offered no training');
SELECT as_user(1);
SELECT is((SELECT (claim_atom('{}'::jsonb)).id), 940001::bigint,
          'an ordinary one is');

UPDATE atom SET state = 'ready' WHERE id = 940002;
UPDATE atom SET state = 'verified' WHERE id = 940001;
SELECT as_user(1);
SELECT is((SELECT (claim_atom('{}'::jsonb)).op), null,
          'and is not yet trusted enough to judge somebody else');
SELECT as_user(2);
SELECT is((SELECT (claim_atom('{}'::jsonb)).id), 940002::bigint,
          'an established worker is');
UPDATE atom SET state = 'ready', worker_id = null, claimed_at = null WHERE id = 940002;

-- ------------------------------------------------------- work earns a little

INSERT INTO tile (z, x, y, dirty, expected_version) VALUES (12, 2560, 1720, true, 1);
INSERT INTO job (id, z, x, y, target_version, state)
VALUES (940002, 12, 2560, 1720, 1, 'open');
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('e', 64), 'ply', 400, 'merge-v1');
INSERT INTO atom (id, job_id, atom_hash, op, algo_version, params, state)
VALUES (940003, 940002, repeat('9', 64), 'merge', 'merge-v1',
        '{"z": 12, "x": 2560, "y": 1720, "budget": 900000}'::jsonb, 'ready');

SELECT as_user(1);
UPDATE atom SET state = 'claimed', worker_id = '00000000-0000-0000-0000-00000000b001',
                claimed_at = now(), heartbeat_at = now() WHERE id = 940003;
SELECT is(submit_atom(940003, repeat('e', 64),
    '{"bytes": 400, "splat_count": 10, "finite": true,
      "bbox": [-100, -5, -100, 100, 30, 100]}'::jsonb),
    'verified', 'an ordinary atom is accepted');
SELECT is((SELECT trust FROM worker WHERE id = '00000000-0000-0000-0000-00000000b001'),
          0.51::numeric(4, 3), 'and the worker gains a little standing');
SELECT is((SELECT ok FROM worker_op_stats
           WHERE worker_id = '00000000-0000-0000-0000-00000000b001' AND op = 'merge'), 1,
          'and the op is counted');

-- ------------------------------------------------ a verdict moves it further

INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('f', 64), 'sog', 900, 'sog-v1');
INSERT INTO atom (id, job_id, atom_hash, op, algo_version, deps, inputs, state,
                  worker_id, output_sha256, result)
VALUES (940004, 940001, repeat('6', 64), 'sog', 'sog-v1', ARRAY[940001], '{}'::jsonb,
        'submitted', '00000000-0000-0000-0000-00000000b003', repeat('f', 64),
        '{"manifest": {"splats": 10}}'::jsonb);
UPDATE atom SET worker_id = '00000000-0000-0000-0000-00000000b004' WHERE id = 940001;
UPDATE atom SET inputs = '{"sog": 940004}'::jsonb, deps = ARRAY[940004]
WHERE id IN (940002, 940005, 940006);

SELECT as_user(2);
SELECT is(submit_verification(940004, true, '{"psnr": 30}'::jsonb), 'submitted',
          'a pass is recorded');
SELECT is((SELECT trust FROM worker WHERE id = '00000000-0000-0000-0000-00000000b004'),
          1::numeric(4, 3), 'the trainer gains by it');
SELECT is((SELECT ok FROM worker_op_stats
           WHERE worker_id = '00000000-0000-0000-0000-00000000b002' AND op = 'verify'), 1,
          'and the verifier is credited with the check');

UPDATE worker SET trust = 0.8 WHERE id = '00000000-0000-0000-0000-00000000b004';
SELECT as_user(1);
SELECT is(submit_verification(940004, false, '{"psnr": 4}'::jsonb), 'waiting',
          'a rejection sends the tile back');
SELECT is((SELECT trust FROM worker WHERE id = '00000000-0000-0000-0000-00000000b004'),
          0.6::numeric(4, 3), 'and costs the trainer four times what a pass is worth');

-- ------------------------------------------------------------ how many checks
--
-- The rejection above sent the train atom back and let go of its worker, so the
-- question is asked of the trainer who would be reused for it.
UPDATE atom SET worker_id = '00000000-0000-0000-0000-00000000b004' WHERE id = 940001;

SELECT is(verify_count(940001), 3, 'an ordinary trainer is checked three times');
UPDATE worker SET trust = 0.96 WHERE id = '00000000-0000-0000-0000-00000000b004';
SELECT is(verify_count(940001), 1, 'one the world trusts is checked once');
SET LOCAL app.verify_min = '5';
UPDATE worker SET trust = 0.5 WHERE id = '00000000-0000-0000-0000-00000000b004';
SELECT is(verify_count(940001), 5, 'and the number is configurable');

SELECT finish();
ROLLBACK;
