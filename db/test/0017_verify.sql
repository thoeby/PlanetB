-- A person is the gate (db/0044_permission.sql, TASKS-usable T7).
--
-- This file used to assert the other answer: three strangers rendering two
-- held-out poses each and agreeing about a PSNR before a trained tile could be
-- published. That was never the same question as "is this what I wanted on my
-- land", and it stood in the way of the one person who could answer it. What is
-- left of Invariant 8 is the honest half — the deterministic ops still have to
-- agree with themselves, and nobody is asked to look at that.
BEGIN;
SELECT plan(11);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land@example.com', 'password12') AS owner_id,
       register('render@example.com', 'password12') AS worker_id,
       register('passer@example.com', 'password12') AS stranger_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000a7'::uuid,
       st_geomfromtext('POLYGON((9.4 48.4,9.6 48.4,9.6 48.6,9.4 48.6,9.4 48.4))', 4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000a7', 'footprint',
        st_geomfromtext('POINTZ(9.5 48.5 400)', 4326));

-- A leaf, not a merge: a merge with nothing published under it is not handed
-- out at all (db/0035_mergeready.sql), which is right and not what this is
-- about.
CREATE TEMP TABLE tt AS
SELECT 14 AS z, tile_x(9.5, 14) AS x, tile_y(48.5, 14) AS y;
-- Claiming the land is an edit too (db/0047_landisground.sql), so the version
-- this tile is waiting for is not always 1.
CREATE TEMP TABLE ver AS
SELECT t.expected_version AS v FROM tile t, tt
WHERE t.z = tt.z AND t.x = tt.x AND t.y = tt.y;

-- the dag ----------------------------------------------------------------
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt)) AS jid;

SELECT is((SELECT count(*)::int FROM atom
           WHERE job_id = (SELECT jid FROM jobs) AND op = 'verify'), 0,
    'nothing is built to check a tile perceptually');
SELECT is((SELECT count(*)::int FROM atom WHERE job_id = (SELECT jid FROM jobs)), 3,
    'a leaf is assembled, sampled and encoded, and that is all');

-- rendering it -----------------------------------------------------------
SELECT set_config('request.jwt.claims',
    json_build_object('sub', worker_id, 'role', 'player')::text, true) FROM ids;

CREATE TEMP TABLE ca AS SELECT (claim_atom('{}'::jsonb)).id AS id;
SELECT is(register_artifact(repeat('6', 64), 'init_ply', 512, 'assemble-v1'),
    repeat('6', 64), 'the assembled scene is registered');
SELECT is(submit_atom((SELECT id FROM ca), repeat('6', 64),
    '{"splat_count": 1000, "finite": true, "gpu_seconds": 1,
      "bbox": [-50, -5, -50, 50, 20, 50]}'::jsonb),
    'verified', 'and accepted on its structural checks');

CREATE TEMP TABLE cm AS SELECT (claim_atom('{}'::jsonb)).id AS id;
SELECT is(register_artifact(repeat('7', 64), 'ply', 1024, 'sample-v1'),
    repeat('7', 64), 'the samples are registered');
SELECT is(submit_atom((SELECT id FROM cm), repeat('7', 64),
    '{"splat_count": 1000, "finite": true, "gpu_seconds": 1,
      "bbox": [-50, -5, -50, 50, 20, 50]}'::jsonb),
    'verified', 'and accepted too');

CREATE TEMP TABLE cs AS SELECT (claim_atom('{}'::jsonb)).id AS id;
SELECT is(register_artifact(repeat('8', 64), 'sog', 2048, 'sog-v1'),
    repeat('8', 64), 'the sog is registered');
SELECT is(submit_atom((SELECT id FROM cs), repeat('8', 64),
    '{"splat_count": 1000, "finite": true, "gpu_seconds": 2,
      "bbox": [-50, -5, -50, 50, 20, 50]}'::jsonb),
    'verified', 'and is verified without waiting for anybody''s opinion');

SELECT ok(publish_tile((SELECT z FROM tt), (SELECT x FROM tt), (SELECT y FROM tt),
    (SELECT v FROM ver),
    repeat('8', 64), '{"origin": {"lon": 9.5, "lat": 48.5, "h": 400}}'::jsonb),
    'the worker publishes it');

-- what everybody else sees ------------------------------------------------
-- Nobody is asked anything here: the person said yes before the render was
-- ever opened (SPEC §0.2, db/0068_approvalfirst.sql), so what lands is what
-- everybody sees.
SELECT is((SELECT t.published_version FROM tile t, tt
           WHERE t.z = tt.z AND t.x = tt.x AND t.y = tt.y), (SELECT v FROM ver),
    'what lands is what everybody sees');
SELECT is((SELECT t.sog_sha256 FROM tile t, tt
           WHERE t.z = tt.z AND t.x = tt.x AND t.y = tt.y), repeat('8', 64),
    'and it is the bytes the worker made');

ROLLBACK;
