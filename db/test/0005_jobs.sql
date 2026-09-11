-- WP0.6 acceptance: DAG shape for z18 and z14, ensure_job idempotency, claim,
-- expiry (attempts++, 3rd -> failed), submit guards, structural budget rule.
BEGIN;
SELECT plan(32);

CREATE TEMP TABLE ids AS
SELECT register('owner@example.com', 'password12') AS owner_id,
       register('other@example.com', 'password12') AS other_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000a1'::uuid,
       st_geomfromtext('POLYGON((7.4 46.4,7.6 46.4,7.6 46.6,7.4 46.6,7.4 46.4))', 4326),
       ids.owner_id, 18
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'footprint',
        st_geomfromtext('POINTZ(7.5 46.5 500)', 4326));

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;

CREATE TEMP TABLE t14 AS SELECT z, x, y FROM tile WHERE z = 14;
CREATE TEMP TABLE t18 AS SELECT z, x, y FROM tile WHERE z = 18;

-- ensure_job ------------------------------------------------------------
CREATE TEMP TABLE jobs AS
SELECT ensure_job(14, (SELECT x FROM t14), (SELECT y FROM t14)) AS j14,
       ensure_job(18, (SELECT x FROM t18), (SELECT y FROM t18)) AS j18;

SELECT is((SELECT ensure_job(14, (SELECT x FROM t14), (SELECT y FROM t14))),
          (SELECT j14 FROM jobs), 'ensure_job twice returns the same job id');
SELECT is((SELECT count(*)::int FROM job), 2, 'exactly two jobs');
SELECT is((SELECT target_version FROM job WHERE id = (SELECT j14 FROM jobs)),
          1::bigint, 'job targets the tile expected_version');

-- DAG shape -------------------------------------------------------------
-- Since db/0016_sample.sql a z14 tile is the baseline: assembled and sampled at
-- its whole budget rather than merged from children it does not have.
SELECT is((SELECT count(*)::int FROM atom WHERE job_id = (SELECT j14 FROM jobs)),
          3, 'z14 job has 3 atoms');
SELECT results_eq(
    $$SELECT op, count(*)::int FROM atom
      WHERE job_id = (SELECT j14 FROM jobs) GROUP BY op ORDER BY op$$,
    $$VALUES ('assemble', 1), ('sample', 1), ('sog', 1)$$,
    'z14 DAG = 1 assemble, 1 sample, 1 sog');
SELECT results_eq(
    $$SELECT op, count(*)::int FROM atom
      WHERE job_id = (SELECT j18 FROM jobs) GROUP BY op ORDER BY op$$,
    $$VALUES ('assemble', 1), ('frame', 6), ('sog', 1), ('train', 1), ('verify', 3)$$,
    'z18 DAG = 1 assemble, 6 frame, 1 train, 1 sog, 3 verify');
SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND state = 'ready'), 1,
    'only the assemble atom starts ready');
SELECT is((SELECT count(*)::int FROM atom
           WHERE op = 'frame' AND (params ->> 'to')::int - (params ->> 'from')::int = 20),
    6, 'frame atoms cover 20 views each');
SELECT is((SELECT (params ->> 'budget')::bigint FROM atom
           WHERE op = 'train'), 2000000::bigint, 'z18 train budget is 2 M');
SELECT ok((SELECT (params ->> 'needs_webgpu')::boolean FROM atom WHERE op = 'train'),
    'train declares its GPU requirement');
SELECT ok((SELECT count(DISTINCT atom_hash) = count(*) FROM atom),
    'every atom_hash is distinct');

-- One published z14 child of that z12 tile: a merge with none at all is not
-- claimable (db/0035_mergeready.sql), and the claim below is about order.
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('9', 64), 'sog', 4096, 'sog-v1');
INSERT INTO tile (z, x, y, dirty, expected_version, sog_sha256)
SELECT 14, t.x * 4, t.y * 4, false, 1, repeat('9', 64)
FROM tile t WHERE t.z = 12
ON CONFLICT (z, x, y) DO UPDATE SET sog_sha256 = excluded.sog_sha256;

-- authorisation ---------------------------------------------------------
SELECT transfer(treasury_account(),
    (SELECT id FROM account WHERE owner_id = ids.other_id), 100, 'seed:other')
FROM ids;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', other_id, 'role', 'player')::text, true) FROM ids;
SELECT throws_ok(
    format($$SELECT ensure_job(12, %s, %s)$$,
           (SELECT x FROM tile WHERE z = 12), (SELECT y FROM tile WHERE z = 12)),
    null, 'a stranger without a bounty cannot open a job');
SELECT lives_ok(
    format($$SELECT ensure_job(12, %s, %s, 5)$$,
           (SELECT x FROM tile WHERE z = 12), (SELECT y FROM tile WHERE z = 12)),
    'a stranger with a bounty can');
SELECT is((SELECT jsonb_array_length(inputs -> 'children') FROM atom WHERE op = 'merge'),
    16, 'the z12 merge pins all 16 grandchildren');
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;

-- claim -----------------------------------------------------------------
CREATE TEMP TABLE claimed AS SELECT * FROM claim_atom('{}'::jsonb);
SELECT is((SELECT op FROM claimed), 'merge', 'a plain worker gets a merge atom');
SELECT is((SELECT bounty FROM job WHERE id = (SELECT job_id FROM claimed)),
    5::numeric, 'the bountied job is served first');
SELECT is((SELECT state FROM atom WHERE id = (SELECT id FROM claimed)), 'claimed',
    'claim marks the atom claimed');
SELECT isnt((SELECT worker_id FROM atom WHERE id = (SELECT id FROM claimed)), null,
    'claim records the worker');
SELECT is((SELECT count(*)::int FROM atom
           WHERE op = 'train' AND state = 'claimed'), 0,
    'a worker without WebGPU never gets the train atom');
SELECT lives_ok(format('SELECT heartbeat(%s)', (SELECT id FROM claimed)),
    'heartbeat on my own claim');

-- structural rule --------------------------------------------------------
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('1', 64), 'ply', 4096, 'merge-v1'),
       (repeat('2', 64), 'ply', 4096, 'merge-v1'),
       (repeat('3', 64), 'sog', 2048, 'sog-v1');

SELECT is(submit_atom((SELECT id FROM claimed), repeat('1', 64),
                      '{"splat_count": 999999999, "finite": true}'::jsonb),
    'ready', 'a result over budget is rejected and the atom goes back to ready');
SELECT is((SELECT attempts FROM atom WHERE id = (SELECT id FROM claimed)),
    1::smallint, 'the rejected attempt is counted');
SELECT ok((SELECT NOT passed FROM verification
           WHERE atom_id = (SELECT id FROM claimed) AND kind = 'structural'),
    'the failed structural check is recorded');

-- a good submission ------------------------------------------------------
CREATE TEMP TABLE reclaim AS SELECT * FROM claim_atom('{}'::jsonb);
SELECT is((SELECT id FROM reclaim), (SELECT id FROM claimed),
    'the atom is claimable again');
-- Since db/0015_structural.sql a splat-producing op also has to say where its
-- splats are; the bbox rule checks that against the tile.
SELECT is(submit_atom((SELECT id FROM claimed), repeat('2', 64),
                      '{"splat_count": 500000, "finite": true,
                        "bbox": [-50, -5, -50, 50, 20, 50]}'::jsonb),
    'verified', 'a deterministic op is verified on submit');
SELECT is((SELECT state FROM atom WHERE op = 'sog'
           AND job_id = (SELECT job_id FROM claimed)), 'ready',
    'its dependent becomes ready');

-- submit guards -----------------------------------------------------------
SELECT throws_ok(format($$SELECT submit_atom(%s, %L, '{}'::jsonb)$$,
        (SELECT id FROM atom WHERE op = 'sog'
         AND job_id = (SELECT job_id FROM claimed)),
        repeat('3', 64)),
    null, 'submitting an atom that is not claimed raises');

-- expiry -------------------------------------------------------------------
CREATE TEMP TABLE sog AS SELECT id FROM claim_atom('{}'::jsonb);
UPDATE atom SET heartbeat_at = now() - interval '6 minutes'
WHERE id = (SELECT id FROM sog);
SELECT is(expire_claims(), 1, 'one dead claim expires');
SELECT is((SELECT state FROM atom WHERE id = (SELECT id FROM sog)), 'ready',
    'an expired claim reverts to ready');
SELECT is((SELECT attempts FROM atom WHERE id = (SELECT id FROM sog)), 1::smallint,
    'and increments attempts');

UPDATE atom SET attempts = 2 WHERE id = (SELECT id FROM sog);
CREATE TEMP TABLE reclaim2 AS SELECT * FROM claim_atom('{}'::jsonb);
UPDATE atom SET heartbeat_at = now() - interval '6 minutes'
WHERE id = (SELECT id FROM sog);
SELECT is(expire_claims(), 1, 'the third expiry also fires');
SELECT is((SELECT state FROM atom WHERE id = (SELECT id FROM sog)), 'failed',
    'three expiries fail the atom');

SELECT * FROM finish();
ROLLBACK;
