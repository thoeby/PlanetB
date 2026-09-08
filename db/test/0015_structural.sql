-- The structural checks, and what happens when two workers disagree about a
-- deterministic op (db/0015_structural.sql).
BEGIN;
SELECT plan(14);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-0000000e5001', 'struct-a@example.com', 'x', 'player'),
('00000000-0000-0000-0000-0000000e5002', 'struct-b@example.com', 'x', 'player');
INSERT INTO account (owner_id) VALUES
('00000000-0000-0000-0000-0000000e5001'), ('00000000-0000-0000-0000-0000000e5002');
INSERT INTO worker (id, user_id, caps) VALUES
('00000000-0000-0000-0000-0000000e5011', '00000000-0000-0000-0000-0000000e5001', '{}'),
('00000000-0000-0000-0000-0000000e5012', '00000000-0000-0000-0000-0000000e5002', '{}');
INSERT INTO tile (z, x, y, dirty, expected_version) VALUES (12, 2139, 1434, true, 1);
INSERT INTO job (id, z, x, y, target_version, state)
VALUES (900001, 12, 2139, 1434, 1, 'open');
INSERT INTO artifact (sha256, kind, bytes, algo_version) VALUES
(repeat('a', 64), 'ply', 1000, 'merge-v1'),
(repeat('b', 64), 'ply', 1000, 'merge-v1');

-- A z12 tile at 47 N is about 6.7 km across.
SELECT cmp_ok(tile_edge_m(12, 2139, 1434), '>', 6000::double precision,
              'a z12 tile is kilometres across');
SELECT cmp_ok(tile_edge_m(12, 2139, 1434), '<', 8000::double precision,
              'and not tens of them');

INSERT INTO atom (id, job_id, atom_hash, op, algo_version, params, state)
VALUES (900001, 900001, repeat('1', 64), 'merge', 'merge-v1',
        '{"z": 12, "x": 2139, "y": 1434, "budget": 900000}'::jsonb, 'ready');

SELECT ok(NOT bbox_fits((SELECT a FROM atom a WHERE a.id = 900001), '{}'::jsonb),
          'a result with no bounding box does not pass');
SELECT ok(bbox_fits((SELECT a FROM atom a WHERE a.id = 900001),
                    '{"bbox": [-100, -5, -100, 100, 30, 100]}'::jsonb),
          'one inside the tile does');
SELECT ok(NOT bbox_fits((SELECT a FROM atom a WHERE a.id = 900001),
                        '{"bbox": [-9000, -5, -100, 100, 30, 100]}'::jsonb),
          'one reaching into the next tile does not');

-- ------------------------------------------------------- a first submission

-- Re-claiming a settled atom is what a re-check does and no RPC offers, so the
-- claims are set by hand here; submit_atom is SECURITY DEFINER and reads the
-- caller from request.jwt.claims either way.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000e5001","role":"player"}';
UPDATE atom SET state = 'claimed', worker_id = '00000000-0000-0000-0000-0000000e5011',
    claimed_at = now(), heartbeat_at = now() WHERE id = 900001;

SELECT is(submit_atom(900001, repeat('a', 64),
    '{"bytes": 1000, "splat_count": 10, "finite": true,
      "bbox": [-100, -5, -100, 100, 30, 100]}'::jsonb),
    'verified', 'a sound merge is verified with no verify atom');

-- A second opinion that agrees is recorded as a hash check and changes nothing.
SELECT ok(recheck_atom(900001), 'a verified merge can be asked for again');
UPDATE atom SET state = 'claimed', worker_id = '00000000-0000-0000-0000-0000000e5012',
    claimed_at = now(), heartbeat_at = now() WHERE id = 900001;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000e5002","role":"player"}';
SELECT is(submit_atom(900001, repeat('a', 64),
    '{"bytes": 1000, "splat_count": 10, "finite": true,
      "bbox": [-100, -5, -100, 100, 30, 100]}'::jsonb),
    'verified', 'and so is the same answer from another worker');
SELECT is((SELECT count(*)::int FROM verification
           WHERE atom_id = 900001 AND kind = 'hash' AND passed), 1,
          'the agreement is recorded as a hash verification');

-- ------------------------------------------------------------ a disagreement

SELECT ok(recheck_atom(900001), 'and again');
UPDATE atom SET state = 'claimed', worker_id = '00000000-0000-0000-0000-0000000e5012',
    claimed_at = now(), heartbeat_at = now() WHERE id = 900001;
SELECT is(submit_atom(900001, repeat('b', 64),
    '{"bytes": 1000, "splat_count": 10, "finite": true,
      "bbox": [-100, -5, -100, 100, 30, 100]}'::jsonb),
    'ready', 'a different answer is trusted from neither, and the atom goes back');
SELECT is((SELECT output_sha256 FROM atom WHERE id = 900001), NULL,
          'the output nobody agrees on is discarded');
SELECT is((SELECT sum(bad)::int FROM worker_op_stats WHERE op = 'merge'), 1,
          'the worker behind an answer nobody agrees with is marked bad');

-- ------------------------------------------------------------ a bad result

UPDATE atom SET state = 'claimed', worker_id = '00000000-0000-0000-0000-0000000e5012',
    claimed_at = now(), heartbeat_at = now() WHERE id = 900001;
SELECT is(submit_atom(900001, repeat('a', 64),
    '{"bytes": 1000, "splat_count": 10, "bbox": [-100, -5, -100, 100, 30, 100]}'::jsonb),
    'ready', 'a result that does not say it is finite is rejected');

SELECT * FROM finish();
ROLLBACK;
