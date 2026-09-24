-- A price on a render job is cash held for it (db/0200_renderingpays.sql).
BEGIN;
SELECT plan(16);

DELETE FROM auth.user;
SELECT register('anna200@example.com', 'password12') AS anna,
       register('ben200@example.com', 'password12') AS ben,
       register('cara200@example.com', 'password12') AS cara \gset
UPDATE auth.user SET name = initcap(split_part(email, '200', 1));
INSERT INTO player_verification (player_id, state, method, how)
VALUES (:'ben', 'verified', 'manual', 'test'), (:'cara', 'verified', 'manual', 'test');
SELECT id AS bens FROM item WHERE held_by = :'ben' \gset
SELECT id AS caras FROM item WHERE held_by = :'cara' \gset
UPDATE wallet SET balance = 100;
DELETE FROM wallet_order;

INSERT INTO tile (z, x, y, dirty, expected_version) VALUES
(16, 34208, 22944, true, 1), (16, 34209, 22944, true, 1);
INSERT INTO job (id, z, x, y, target_version, state) VALUES
(920001, 16, 34208, 22944, 1, 'open'), (920002, 16, 34209, 22944, 1, 'open');
INSERT INTO worker (id, user_id, caps) VALUES ('00000000-0000-0000-0000-000000920011', :'cara', '{}');
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('c', 64), 'sog', 10, 'sog-v1') ON CONFLICT DO NOTHING;
INSERT INTO atom (id, job_id, atom_hash, op, algo_version, params, state, output_sha256,
                  worker_id, result)
VALUES (920001, 920001, repeat('7', 64), 'sog', 'sog-v1', '{}'::jsonb, 'verified',
        repeat('c', 64), '00000000-0000-0000-0000-000000920011', '{"gpu_seconds": 30}');

CREATE FUNCTION acting_as(uid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r text := (SELECT role FROM auth.user WHERE id = uid);
BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
        json_build_object('sub', uid, 'role', r)::text);
    EXECUTE format('SET LOCAL ROLE %I', r);
END
$$;
GRANT EXECUTE ON FUNCTION acting_as(uuid) TO player, admin;

-- A price, held ----------------------------------------------------------------
SELECT acting_as(:'ben');
SELECT is(set_price(920001, 10) ->> 'state', 'queued', 'Ben puts 10 on his job');
SELECT throws_ok($$SELECT set_price(920001, 5)$$, '23514',
                 'this job has a price on it already — withdraw it first', 'once');
RESET ROLE;
SELECT id AS o1 FROM wallet_order WHERE for_what ->> 'job' = '920001' \gset
SELECT is((SELECT row(kind, wallet_id::text, amount)::text FROM wallet_order WHERE id = :'o1'),
          format('(hold,%s,10.00)', :'bens'), 'held from his wallet');
SELECT walletd_said(:'o1', 'held', '');
SELECT is((SELECT bounty FROM job WHERE id = 920001), 10.00, 'and the pool shows it');
SELECT acting_as(:'cara');
SELECT throws_ok($$SELECT withdraw_price(920001)$$, '42501',
                 'that price is not yours to withdraw', 'nobody else withdraws it');

-- The tile publishes -------------------------------------------------------------
RESET ROLE;
SELECT release_escrow(920001);
SELECT is((SELECT row(state, other_id::text)::text FROM wallet_order WHERE id = :'o1'),
          format('(confirmed,%s)', :'caras'), 'published: Cara''s wallet collects it');
SELECT is((SELECT said FROM wallet_order WHERE id = :'o1'),
          'The tile published: Cara collects it.', 'and it says so');
SELECT walletd_said(:'o1', 'done', '');
SELECT is((SELECT bounty FROM job WHERE id = 920001), 0.00, 'collected, the job holds nothing');

-- Withdrawn -------------------------------------------------------------------
SELECT acting_as(:'ben');
SELECT lives_ok($$SELECT set_price(920002, 7)$$, 'a second job gets a price');
RESET ROLE;
SELECT id AS o2 FROM wallet_order WHERE for_what ->> 'job' = '920002' \gset
SELECT acting_as(:'ben');
SELECT throws_ok($$SELECT withdraw_price(920002)$$, '23514', 'the price is queued — a moment',
                 'withdrawing a price still leaving the wallet waits for it');
RESET ROLE;
SELECT walletd_said(:'o2', 'held', '');
SELECT acting_as(:'ben');
SELECT is(withdraw_price(920002) ->> 'state', 'releasing', 'Ben withdraws it');
RESET ROLE;
SELECT walletd_said(:'o2', 'returned', 'It came back.');
SELECT is((SELECT bounty FROM job WHERE id = 920002), 0.00, 'back, the job holds nothing');

-- Dropped while leaving -----------------------------------------------------------
SELECT acting_as(:'ben');
SELECT lives_ok($$SELECT set_price(920002, 3)$$, 'a third price');
RESET ROLE;
SELECT max(id) AS o3 FROM wallet_order \gset
SELECT refund_bounty(920002);
SELECT is((SELECT state FROM wallet_order WHERE id = :'o3'), 'refused',
          'the job is dropped before the price has left');
SELECT walletd_said(:'o3', 'held', '');
SELECT is((SELECT state FROM wallet_order WHERE id = :'o3'), 'releasing',
          'and once it has, it is given straight back');

-- Nobody with a wallet rendered it ------------------------------------------------
UPDATE job SET state = 'open' WHERE id = 920002;
INSERT INTO wallet_order (kind, wallet_id, amount, ref, for_what, state)
VALUES ('hold', :'bens', 2, 'price:t', '{"job": 920002}', 'held');
SELECT release_escrow(920002);
SELECT is((SELECT state FROM wallet_order WHERE ref = 'price:t'), 'releasing',
          'a tile nobody with a wallet rendered sends the price back');

SELECT * FROM finish();
ROLLBACK;
