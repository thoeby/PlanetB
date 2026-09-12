-- The close-out review's fixes (db/0026_review.sql): instances are bounded by
-- their area, user refs cannot collide with system refs, a retried ensure_job
-- does not pay twice, a cancelled job refunds its bounty, two payouts fit in
-- one transaction, a trained tile cannot be re-checked, a re-checked job
-- closes again, and internal functions are not executable by clients.
BEGIN;
SELECT plan(17);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('rv-owner@example.com', 'password12') AS owner_id,
       register('rv-worker@example.com', 'password12') AS worker_id;
SELECT transfer(treasury_account(),
    (SELECT id FROM account WHERE owner_id = ids.owner_id), 100, 'seed:rv') FROM ids;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000b1'::uuid,
       st_geomfromtext('POLYGON((7.4 46.4,7.6 46.4,7.6 46.6,7.4 46.6,7.4 46.4))', 4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('c', 64), 'glb', 10, 'canon-v1');
INSERT INTO asset (san, sha256, canon_version, name, category, license, bbox, tris,
                   tex_bytes, creator_id)
SELECT 'SAAAAAAAAAAAA', repeat('c', 64), 1, 'tree', 'flora', 'cc0', '[0,0,0,1,1,1]', 12,
       0, ids.owner_id FROM ids;

-- --------------------------------------------------------- instance bounds

SELECT throws_like($$
    INSERT INTO instance (area_id, san, lon, lat, h)
    VALUES ('00000000-0000-0000-0000-0000000000b1', 'SAAAAAAAAAAAA', 0, 0, 0)
$$, '%outside area%', 'an instance outside its area is refused');
SELECT lives_ok($$
    INSERT INTO instance (area_id, san, lon, lat, h)
    VALUES ('00000000-0000-0000-0000-0000000000b1', 'SAAAAAAAAAAAA', 7.5, 46.5, 0)
$$, 'one inside is accepted');
-- Five, and only the five above it: the land's own tiles are there too since
-- db/0047_landisground.sql, so what this counts is what the instance moved.
SELECT is((SELECT count(*)::int FROM tile WHERE expected_version > 1), 5,
          'and dirties the five tiles above it, nowhere else');

-- ------------------------------------------------------------ system refs

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT lives_ok($$ SELECT pay(treasury_account(), 1, 'pay:1:x') $$,
                'a player may use any ref they like');
SELECT is((SELECT count(*)::int FROM ledger WHERE ref = 'pay:1:x'), 0,
          'but it is namespaced under their account, never a system ref');
SELECT throws_ok($$ SELECT pay(treasury_account(), 1, 'pay:1:x') $$, '23505',
                 null, 'and repeating it still raises');

-- ------------------------------------------------------------- bounties

-- The z12 tile the instance above is standing on. Since land is ground there
-- are many z12 tiles now, and any one of them is not this one.
CREATE TEMP TABLE tt AS SELECT tile_x(7.5, 12) AS x, tile_y(46.5, 12) AS y;
CREATE TEMP TABLE j1 AS
SELECT ensure_job(12, (SELECT x FROM tt), (SELECT y FROM tt), 10) AS jid;
SELECT is(ensure_job(12, (SELECT x FROM tt), (SELECT y FROM tt), 10),
          (SELECT jid FROM j1), 'a retried ensure_job returns the same job');
SELECT is(account_balance(escrow_account()), 10::numeric, 'and charges once');
SELECT lives_ok($$ SELECT set_bounty((SELECT jid FROM j1), 5) $$,
                'a bounty can be topped up');
SELECT is((SELECT bounty FROM job WHERE id = (SELECT jid FROM j1)), 15::numeric,
          'to the new total');

-- The world moves on: the old job is cancelled and its escrow comes back.
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000b1', 'footprint',
        st_geomfromtext('POINTZ(7.5 46.5 500)', 4326));
CREATE TEMP TABLE j2 AS
SELECT ensure_job(12, (SELECT x FROM tt), (SELECT y FROM tt)) AS jid;
SELECT is((SELECT state FROM job WHERE id = (SELECT jid FROM j1)), 'cancelled',
          'the older job is cancelled');
SELECT is(account_balance(escrow_account()), 0::numeric,
          'and its bounty is refunded');
SELECT is(account_balance(my_account()), 99::numeric,
          'to whoever paid it');

-- ----------------------------------------------------- two payouts, one txn

SELECT lives_ok($$ SELECT release_escrow((SELECT jid FROM j1)),
                          release_escrow((SELECT jid FROM j2)) $$,
                'two payouts in one transaction do not collide');

-- ------------------------------------------------------- recheck at z16

INSERT INTO tile (z, x, y, dirty, expected_version, published_version)
VALUES (16, 34208, 22944, false, 1, 1);
INSERT INTO job (id, z, x, y, target_version, state)
VALUES (917001, 16, 34208, 22944, 1, 'done');
INSERT INTO atom (id, job_id, atom_hash, op, algo_version, params, state, output_sha256)
VALUES (917001, 917001, repeat('7', 64), 'sog', 'sog-v1',
        '{"z": 16, "x": 34208, "y": 22944}'::jsonb, 'verified', repeat('c', 64));
SELECT ok(NOT recheck_atom(917001), 'a trained tile is not re-checked by hash');

-- A z12 job reopened for a re-check closes again once its last atom settles.
INSERT INTO tile (z, x, y, dirty, expected_version, published_version)
VALUES (12, 2000, 1400, false, 1, 1);
INSERT INTO job (id, z, x, y, target_version, state)
VALUES (917002, 12, 2000, 1400, 1, 'open');
INSERT INTO atom (id, job_id, atom_hash, op, algo_version, params, state, output_sha256)
VALUES (917002, 917002, repeat('8', 64), 'merge', 'merge-v1',
        '{"z": 12, "x": 2000, "y": 1400}'::jsonb, 'verified', repeat('c', 64));
SELECT advance_atoms(917002);
SELECT is((SELECT state FROM job WHERE id = 917002), 'done',
          'a re-checked job whose tile is already published closes again');

-- ---------------------------------------------------------------- grants

SELECT ok(NOT has_function_privilege('player', 'transfer(uuid, uuid, numeric, text)', 'EXECUTE'),
          'a player cannot call transfer() directly');

SELECT * FROM finish();
ROLLBACK;
