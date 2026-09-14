-- A tab that cannot do a piece says so, and the piece is somebody's to take
-- at once: an attempt counted, the third one final, and only the holder may.
BEGIN;
SELECT plan(9);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('hold93@example.com', 'password12') AS holder_id,
       register('other93@example.com', 'password12') AS other_id;
INSERT INTO worker (id, user_id, caps, trust)
SELECT '00000000-0000-0000-0000-000000000931'::uuid, holder_id, '{}', 0.8 FROM ids;
INSERT INTO worker (id, user_id, caps, trust)
SELECT '00000000-0000-0000-0000-000000000932'::uuid, other_id, '{}', 0.8 FROM ids;

INSERT INTO tile (z, x, y, dirty, expected_version) VALUES (14, 9301, 9301, true, 1);
INSERT INTO job (id, z, x, y, target_version, state)
VALUES (930001, 14, 9301, 9301, 1, 'open');
INSERT INTO atom (id, job_id, atom_hash, op, algo_version, inputs, params, seed, state,
                  worker_id, claimed_at, heartbeat_at, attempts)
VALUES (930001, 930001, repeat('9', 64), 'assemble', 'assemble-v2', '{}', '{}', 0,
        'claimed', '00000000-0000-0000-0000-000000000931', now(), now(), 0);

-- Somebody else cannot fail it.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', other_id, 'role', 'player')::text, true) FROM ids;
SELECT throws_ok($$SELECT fail_atom(930001, 'not mine')$$, '42501',
    'that piece is not in your hands', 'only the holder may say it failed');

-- The holder can, and it is ready again for anybody, with the reason on it.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', holder_id, 'role', 'player')::text, true) FROM ids;
SELECT is(fail_atom(930001, 'no ground at 14/9301/9301'), 'ready',
    'the first failure puts it back in the pool');
SELECT is((SELECT attempts FROM atom WHERE id = 930001), 1::smallint, 'and counts an attempt');
SELECT is((SELECT worker_id FROM atom WHERE id = 930001), null, 'in nobody''s hands');
SELECT is((SELECT result ->> 'error' FROM atom WHERE id = 930001),
    'no ground at 14/9301/9301', 'with the reason recorded');
SELECT is(fail_atom(930001, 'again'), 'ready', 'an atom that is not claimed is left as it is');

-- The third attempt is the last.
UPDATE atom SET state = 'claimed', worker_id = '00000000-0000-0000-0000-000000000931',
                claimed_at = now(), attempts = 2 WHERE id = 930001;
SELECT is(fail_atom(930001, 'still no ground'), 'failed',
    'three failures and the piece has given up');
SELECT is((SELECT attempts FROM atom WHERE id = 930001), 3::smallint, 'all three counted');
SELECT is(fail_atom(930002, 'x'), 'missing', 'an atom that does not exist is missing');

SELECT * FROM finish();
ROLLBACK;
