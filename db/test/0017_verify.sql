-- The perceptual half of Invariant 8: three independent tabs, none of them the
-- one that made the tile, and what happens when one of them says no
-- (db/0017_verify.sql, db/0017_verifydag.sql).
BEGIN;
SELECT plan(21);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role)
SELECT ('00000000-0000-0000-0000-00000000f00' || n)::uuid,
       'verify-' || n || '@example.com', 'x', 'player'
FROM generate_series(1, 5) AS n;
INSERT INTO account (owner_id)
SELECT ('00000000-0000-0000-0000-00000000f00' || n)::uuid FROM generate_series(1, 5) AS n;
-- Established workers: judging somebody else's tile needs trust >= 0.6
-- (db/0019_trust.sql), which a tab earns by having its own work accepted.
INSERT INTO worker (id, user_id, caps, trust)
SELECT ('00000000-0000-0000-0000-00000000e00' || n)::uuid,
       ('00000000-0000-0000-0000-00000000f00' || n)::uuid, '{}', 0.8
FROM generate_series(1, 5) AS n;

CREATE FUNCTION as_user(n int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
        json_build_object('sub', '00000000-0000-0000-0000-00000000f00' || n,
                          'role', 'player')::text);
END
$$;

-- claim_atom picks globally (db/0005_state.sql), so anything else left ready by
-- an earlier run would be handed out here instead. This transaction rolls back.
UPDATE atom SET state = 'waiting' WHERE state = 'ready';

CREATE FUNCTION settle(p_job bigint, p_ops text [], p_worker uuid) RETURNS void
LANGUAGE sql AS $$
UPDATE atom SET state = 'ready' WHERE job_id = p_job AND op = ANY (p_ops)
                                  AND state = 'waiting';
UPDATE atom SET state = 'claimed', worker_id = p_worker, claimed_at = now(),
                heartbeat_at = now()
WHERE job_id = p_job AND op = ANY (p_ops) AND state = 'ready';
UPDATE atom SET state = 'verified' WHERE job_id = p_job AND op = ANY (p_ops)
                                     AND state = 'claimed';
SELECT advance_atoms(p_job);
$$;

-- ------------------------------------------------------------------ the dag

INSERT INTO tile (z, x, y, dirty, expected_version) VALUES (16, 40001, 30001, true, 1);
INSERT INTO job (id, z, x, y, target_version, state)
VALUES (930001, 16, 40001, 30001, 1, 'open');
SELECT build_dag(930001, 16, 40001, 30001);

SELECT is((SELECT count(*)::int FROM atom WHERE job_id = 930001 AND op = 'verify'), 3,
          'a trained tile is checked three times');
SELECT is((SELECT count(DISTINCT params ->> 'index')::int FROM atom
           WHERE job_id = 930001 AND op = 'verify'), 3,
          'and each check takes a different pair of held-out poses');
SELECT is((SELECT params ->> 'camera_set' FROM atom
           WHERE job_id = 930001 AND op = 'verify' ORDER BY id LIMIT 1), 'z16-v1',
          'a verify atom is told which camera set to look up');
SELECT ok((SELECT jsonb_array_length(inputs -> 'frames') FROM atom
           WHERE job_id = 930001 AND op = 'verify' ORDER BY id LIMIT 1) = 3,
          'and is given the frames as well as the sog');

-- ------------------------------------------------------- up to the .sog

INSERT INTO artifact (sha256, kind, bytes, algo_version) VALUES
(repeat('c', 64), 'sog', 5000, 'sog-v1'), (repeat('d', 64), 'sog', 5000, 'sog-v1');

SELECT settle(930001, ARRAY['assemble', 'frame', 'train'],
              '00000000-0000-0000-0000-00000000e001');

SELECT as_user(2);
UPDATE atom SET state = 'claimed', worker_id = '00000000-0000-0000-0000-00000000e002',
                claimed_at = now(), heartbeat_at = now()
WHERE job_id = 930001 AND op = 'sog';
SELECT is(submit_atom((SELECT id FROM atom WHERE job_id = 930001 AND op = 'sog'),
    repeat('c', 64),
    ('{"bytes": 5000, "splat_count": 10, "finite": true,'
     || '"bbox": [-10, -5, -10, 10, 30, 10],'
     || '"manifest": {"splats": 10, "origin": {"lon": 8, "lat": 47, "h": 400}}}')::jsonb),
    'submitted', 'the sog of a trained tile waits for its perceptual checks');
SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = 930001 AND op = 'verify' AND state = 'ready'), 3,
          'and the three checks are claimable as soon as it is submitted');

-- ------------------------------------------------------------ who may check

SELECT as_user(1);
SELECT is((SELECT (claim_atom('{}'::jsonb)).op), null,
          'the tab that trained the tile is offered no check of it');
SELECT as_user(3);
SELECT is((SELECT (claim_atom('{}'::jsonb)).op), 'verify',
          'a third party is');
SELECT is((SELECT (claim_atom('{}'::jsonb)).op), null,
          'and may not take a second check of the same tile');

SELECT as_user(2);
SELECT throws_ok(
    format('SELECT submit_verification(%s, true)',
           (SELECT id FROM atom WHERE job_id = 930001 AND op = 'sog')),
    null::text, null, 'the tab that encoded the sog may not vouch for it');

-- ------------------------------------------------------------ three passes

CREATE FUNCTION says(n int, ok boolean) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    out text;
BEGIN
    PERFORM as_user(n);
    SELECT submit_verification(a.id, ok, '{"psnr": 27.5}'::jsonb) INTO out
    FROM atom a WHERE a.job_id = 930001 AND a.op = 'sog';
    RETURN out;
END
$$;

SELECT is(says(3, true), 'submitted', 'one pass is not enough');
SELECT is(says(4, true), 'submitted', 'nor two');
SELECT is(says(5, true), 'verified', 'three independent passes verify the sog');
SELECT is((SELECT published_version FROM tile WHERE z = 16 AND x = 40001 AND y = 30001),
          1::bigint, 'and the tile is published without the encoder coming back');
SELECT is((SELECT state FROM job WHERE id = 930001), 'done', 'the job is done');

-- ------------------------------------------------------------ a rejection

INSERT INTO tile (z, x, y, dirty, expected_version) VALUES (16, 40002, 30001, true, 1);
INSERT INTO job (id, z, x, y, target_version, state)
VALUES (930002, 16, 40002, 30001, 1, 'open');
SELECT build_dag(930002, 16, 40002, 30001);
SELECT settle(930002, ARRAY['assemble', 'frame', 'train'],
              '00000000-0000-0000-0000-00000000e001');
UPDATE atom SET state = 'claimed', worker_id = '00000000-0000-0000-0000-00000000e002',
                claimed_at = now(), heartbeat_at = now()
WHERE job_id = 930002 AND op = 'sog';
UPDATE atom SET state = 'submitted', output_sha256 = repeat('d', 64),
                result = '{"manifest": {"splats": 10}}'::jsonb
WHERE job_id = 930002 AND op = 'sog';

SELECT as_user(3);
SELECT is((SELECT submit_verification(a.id, false, '{"psnr": 9.1}'::jsonb)
           FROM atom a WHERE a.job_id = 930002 AND a.op = 'sog'), 'waiting',
          'one rejection sends the tile back to its trainer');
SELECT is((SELECT bad FROM worker_op_stats
           WHERE worker_id = '00000000-0000-0000-0000-00000000e001' AND op = 'train'), 1,
          'and the trainer, not the encoder, is marked bad for it');
SELECT is((SELECT state FROM atom WHERE job_id = 930002 AND op = 'train'), 'ready',
          'the train atom is offered again');

-- Twice more, and the tile gives up at this version, which is what every other
-- unresolvable result here does (db/0015_structural.sql).
CREATE FUNCTION rejects(n int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    out text;
BEGIN
    -- The same trainer has another go, and produces the same bad tile.
    PERFORM settle(930002, ARRAY['train'], '00000000-0000-0000-0000-00000000e001');
    UPDATE atom SET state = 'ready' WHERE job_id = 930002 AND op = 'sog';
    UPDATE atom SET state = 'claimed', worker_id = '00000000-0000-0000-0000-00000000e002',
                    claimed_at = now(), heartbeat_at = now()
    WHERE job_id = 930002 AND op = 'sog';
    UPDATE atom SET state = 'submitted', output_sha256 = repeat('d', 64),
                    result = '{"manifest": {"splats": 10}}'::jsonb
    WHERE job_id = 930002 AND op = 'sog';
    PERFORM as_user(n);
    SELECT submit_verification(a.id, false, '{"psnr": 9.1}'::jsonb) INTO out
    FROM atom a WHERE a.job_id = 930002 AND a.op = 'sog';
    RETURN out;
END
$$;

SELECT is(rejects(4), 'waiting', 'a second rejection sends it back once more');
SELECT is(rejects(5), 'failed', 'the third fails the sog for good');
SELECT is((SELECT sum(bad)::int FROM worker_op_stats
           WHERE worker_id = '00000000-0000-0000-0000-00000000e001' AND op = 'train'), 3,
          'and the trainer wears all three');

SELECT finish();
ROLLBACK;
