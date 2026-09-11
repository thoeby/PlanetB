-- A merge atom with no published child is not handed out (db/0035_mergeready.sql).
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('merge-worker@example.com', 'password12') AS worker_id;
GRANT SELECT ON ids TO player;

-- claim_atom picks globally (db/0005_state.sql), so nothing else may be ready.
UPDATE atom SET state = 'waiting' WHERE state = 'ready';

INSERT INTO tile (z, x, y, dirty, expected_version)
VALUES (12, 2125, 1425, true, 1), (12, 2126, 1425, true, 1);

INSERT INTO job (id, z, x, y, target_version, state, bounty) VALUES
(910001, 12, 2125, 1425, 1, 'open', 0),
(910002, 12, 2126, 1425, 1, 'open', 0);

-- The first is what a brand new world builds: sixteen children, none of them
-- published yet. The second has one.
INSERT INTO atom (id, job_id, atom_hash, op, algo_version, inputs, params, seed, state)
VALUES
(910001, 910001, repeat('a', 64), 'merge', 'merge-v1',
 jsonb_build_object('children',
     (SELECT jsonb_agg(''::text) FROM generate_series(1, 16))), '{}', 1, 'ready'),
(910002, 910002, repeat('b', 64), 'merge', 'merge-v1',
 jsonb_build_object('children',
     (SELECT jsonb_agg(CASE WHEN i = 3 THEN repeat('c', 64) ELSE ''::text END)
      FROM generate_series(1, 16) i)), '{}', 1, 'ready');

SELECT ok(NOT merge_has_a_child(
              (SELECT inputs FROM atom WHERE id = 910001)),
          'sixteen empty children is nothing to merge');
SELECT ok(merge_has_a_child((SELECT inputs FROM atom WHERE id = 910002)),
          'one published child is enough');
SELECT ok(NOT merge_has_a_child('{}'::jsonb), 'and so is no children key at all');

SELECT set_config('request.jwt.claims',
    json_build_object('sub', worker_id, 'role', 'player')::text, true) FROM ids;

CREATE TEMP TABLE c1 AS SELECT * FROM claim_atom('{"ops": ["merge"]}'::jsonb);
SELECT is((SELECT id FROM c1), 910002::bigint,
          'the merge that has something to merge is the one handed out');

CREATE TEMP TABLE c2 AS SELECT * FROM claim_atom('{"ops": ["merge"]}'::jsonb);
SELECT ok((SELECT id FROM c2) is null,
          'and the empty one is never claimed, however long a tab asks');
SELECT is((SELECT state FROM atom WHERE id = 910001), 'ready',
          'it stays ready: publishing a child dirties the parent and rebuilds');

SELECT * FROM finish();
ROLLBACK;
