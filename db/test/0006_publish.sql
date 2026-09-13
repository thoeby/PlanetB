-- WP0.8 acceptance: CAS publish bumps the parent, a stale publish changes
-- nothing, a double publish is a no-op, a bounty of 10 splits 6/4 by
-- gpu_seconds, and a repeated pay ref raises without moving money.
BEGIN;
SELECT plan(26);

SELECT has_function('public', 'publish_tile',
    ARRAY['integer', 'integer', 'integer', 'bigint', 'text', 'jsonb'],
    'publish_tile()');
SELECT is(account_balance(escrow_account()), 0::numeric, 'escrow starts empty');

CREATE TEMP TABLE ids AS
SELECT register('owner@example.com', 'password12') AS owner_id,
       register('wa@example.com', 'password12') AS wa_id,
       register('wb@example.com', 'password12') AS wb_id;
GRANT SELECT ON ids TO player;

SELECT transfer(treasury_account(),
    (SELECT id FROM account WHERE owner_id = ids.owner_id), 100, 'seed:owner')
FROM ids;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000a1'::uuid,
       st_geomfromtext('POLYGON((7.4 46.4,7.6 46.4,7.6 46.6,7.4 46.6,7.4 46.4))', 4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (id, area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000f1',
        '00000000-0000-0000-0000-0000000000a1', 'footprint',
        st_geomfromtext('POINTZ(7.5 46.5 500)', 4326));

-- z12, because since db/0016_sample.sql a z14 tile is assembled and sampled
-- rather than merged, and this is about the merge -> sog -> publish path.
CREATE TEMP TABLE tt AS SELECT tile_x(7.5, 12) AS x, tile_y(46.5, 12) AS y;
-- What that tile is waiting for. Claiming the land is itself an edit
-- (db/0047_landisground.sql), so this is not always 1.
CREATE TEMP TABLE ver AS
SELECT t.expected_version AS v FROM tile t, tt
WHERE t.z = 12 AND t.x = tt.x AND t.y = tt.y;

-- One published z14 child, because a merge with none at all is not claimable
-- (db/0035_mergeready.sql).
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('9', 64), 'sog', 4096, 'sog-v1');
INSERT INTO tile (z, x, y, dirty, expected_version, sog_sha256)
SELECT 14, (SELECT x FROM tt) * 4, (SELECT y FROM tt) * 4, false, 1, repeat('9', 64)
ON CONFLICT (z, x, y) DO UPDATE SET sog_sha256 = excluded.sog_sha256;

-- owner opens the job and funds it -------------------------------------
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job(12, (SELECT x FROM tt), (SELECT y FROM tt), 10) AS jid;
SELECT is(account_balance(escrow_account()), 10::numeric,
    'the bounty is escrowed, not just recorded');
SELECT is((SELECT bounty FROM job WHERE id = (SELECT jid FROM jobs)), 10::numeric,
    'the job carries the bounty');

-- worker A runs the merge (6 gpu-seconds) -------------------------------
SELECT set_config('request.jwt.claims',
    json_build_object('sub', wa_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE ca AS SELECT * FROM claim_atom('{}'::jsonb);
SELECT is((SELECT op FROM ca), 'merge', 'worker A claims the merge');
SELECT is(register_artifact(repeat('1', 64), 'ply', 4096, 'merge-v1'),
    repeat('1', 64), 'worker A registers its output');
SELECT is(submit_atom((SELECT id FROM ca), repeat('1', 64),
    '{"splat_count": 500000, "finite": true, "gpu_seconds": 6,
      "bbox": [-50, -5, -50, 50, 20, 50]}'::jsonb),
    'verified', 'the merge verifies');

-- worker B runs the sog (4 gpu-seconds) ---------------------------------
SELECT set_config('request.jwt.claims',
    json_build_object('sub', wb_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE cb AS SELECT * FROM claim_atom('{}'::jsonb);
SELECT is((SELECT op FROM cb), 'sog', 'worker B claims the sog');
SELECT is(register_artifact(repeat('2', 64), 'sog', 2048, 'sog-v1'),
    repeat('2', 64), 'worker B registers its output');
SELECT is(submit_atom((SELECT id FROM cb), repeat('2', 64),
    '{"splat_count": 500000, "finite": true, "gpu_seconds": 4,
      "bbox": [-50, -5, -50, 50, 20, 50]}'::jsonb),
    'verified', 'a merged tile needs no perceptual check (Invariant 7)');

-- publish ---------------------------------------------------------------
-- What lands is published (SPEC §0.2, db/0068_approvalfirst.sql): the person
-- said yes before the render, so nobody is asked a second time. The
-- compare-and-swap is unchanged.
SELECT ok(publish_tile(12, (SELECT x FROM tt), (SELECT y FROM tt), (SELECT v FROM ver),
    repeat('2', 64), '{"origin": {"lon": 7.5, "lat": 46.5, "h": 500}}'::jsonb),
    'a rendered tile is published when it lands');
SELECT is((SELECT t.published_version FROM tile t, tt
           WHERE t.z = 12 AND t.x = tt.x AND t.y = tt.y), (SELECT v FROM ver),
    'the tile records the published version');
SELECT is((SELECT t.expected_version FROM tile t, tt
           WHERE t.z = 10 AND t.x = tt.x / 4 AND t.y = tt.y / 4),
    (SELECT v + 1 FROM ver), 'the parent expected_version is bumped');
SELECT ok((SELECT t.dirty FROM tile t, tt
           WHERE t.z = 10 AND t.x = tt.x / 4 AND t.y = tt.y / 4), 'the parent is dirty');
SELECT ok(NOT (SELECT t.dirty FROM tile t, tt
                WHERE t.z = 12 AND t.x = tt.x AND t.y = tt.y),
    'the published tile is clean again');
SELECT is((SELECT state FROM job WHERE id = (SELECT jid FROM jobs)), 'done',
    'the job is done');

-- escrow split ----------------------------------------------------------
SELECT is((SELECT account_balance(id) FROM account WHERE owner_id = ids.wa_id),
    6::numeric, 'worker A is paid 6 of 10 by gpu_seconds') FROM ids;
SELECT is((SELECT account_balance(id) FROM account WHERE owner_id = ids.wb_id),
    4::numeric, 'worker B is paid 4 of 10') FROM ids;
SELECT is(account_balance(escrow_account()), 0::numeric, 'escrow is empty again');

-- double publish ---------------------------------------------------------
-- back to the worker: publishing is the worker's act, approving is the owner's.
SELECT set_config('request.jwt.claims',
    json_build_object('sub', wb_id, 'role', 'player')::text, true) FROM ids;
SELECT ok(NOT publish_tile(12, (SELECT x FROM tt), (SELECT y FROM tt), (SELECT v FROM ver),
    repeat('2', 64), '{}'::jsonb),
    'publishing the same version twice is a no-op');
SELECT is((SELECT t.expected_version FROM tile t, tt
           WHERE t.z = 10 AND t.x = tt.x / 4 AND t.y = tt.y / 4),
    (SELECT v + 1 FROM ver), 'and does not bump the parent again');

-- stale publish -----------------------------------------------------------
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
UPDATE feature SET props = '{"height": 9}'::jsonb
WHERE id = '00000000-0000-0000-0000-0000000000f1';
SELECT set_config('request.jwt.claims',
    json_build_object('sub', wb_id, 'role', 'player')::text, true) FROM ids;
SELECT ok(NOT publish_tile(12, (SELECT x FROM tt), (SELECT y FROM tt), (SELECT v FROM ver),
    repeat('2', 64), '{}'::jsonb),
    'a stale worker can never publish (Invariant 3)');
SELECT is((SELECT t.published_version FROM tile t, tt
           WHERE t.z = 12 AND t.x = tt.x AND t.y = tt.y), (SELECT v FROM ver),
    'and the tile is unchanged');

-- ledger idempotency -------------------------------------------------------
SELECT lives_ok(
    $$SELECT pay((SELECT id FROM account WHERE owner_id = (SELECT owner_id FROM ids)),
                 1, 'tip:1')$$, 'a tip goes through');
SELECT throws_ok(
    $$SELECT pay((SELECT id FROM account WHERE owner_id = (SELECT owner_id FROM ids)),
                 1, 'tip:1')$$, '23505', null,
    'the same ref cannot be paid twice');
SELECT is((SELECT account_balance(id) FROM account WHERE owner_id = ids.wb_id),
    3::numeric, 'and the balance moved exactly once') FROM ids;

SELECT * FROM finish();
ROLLBACK;
