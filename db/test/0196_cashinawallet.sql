-- Cash in a wallet (db/0196_cashinawallet.sql): where it comes from, who sees
-- it, and what walletd may do.
BEGIN;
SELECT plan(17);

DELETE FROM auth.user;
SELECT register('anna196@example.com', 'password12') AS anna,
       register('ben196@example.com', 'password12') AS ben,
       register('cara196@example.com', 'password12') AS cara \gset
UPDATE auth.user SET name = initcap(split_part(email, '196', 1));

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

-- The starting amount -------------------------------------------------------
SELECT is((SELECT count(*)::int FROM wallet_order WHERE ref = 'start:' || :'anna'), 1,
          'the operator, verified by being it, is issued the starting amount');
SELECT is((SELECT count(*)::int FROM item WHERE held_by = :'ben'), 0,
          'an unverified player holds no wallet');
INSERT INTO player_verification (player_id, state, method, how)
VALUES (:'ben', 'verified', 'manual', 'test');
SELECT is((SELECT count(*)::int FROM item WHERE held_by = :'ben' AND kind = 'wallet'), 1,
          'verified, Ben holds one wallet');
SELECT is((SELECT amount FROM wallet_order WHERE ref = 'start:' || :'ben'), 100.00,
          'and the world issues the starting amount into it');
UPDATE player_verification SET state = 'revoked' WHERE player_id = :'ben';
UPDATE player_verification SET state = 'verified' WHERE player_id = :'ben';
SELECT is((SELECT count(*)::int FROM wallet_order WHERE wallet_id IN
           (SELECT id FROM item WHERE held_by = :'ben')), 1,
          'verified again, nothing more is issued');

-- Who sees what -------------------------------------------------------------
SELECT id AS bens FROM item WHERE held_by = :'ben' \gset
UPDATE wallet SET balance = 100, pending = false WHERE item_id = :'bens';
SELECT acting_as(:'ben');
SELECT is((my_items() -> 0 ->> 'balance')::numeric, 100.00, 'Ben sees his cash');
SELECT is(jsonb_array_length(wallet_history(:'bens')), 1, 'and where it came from');
SELECT is(wallet_history(:'bens') -> 0 ->> 'with', 'the world', 'which is the world');
SELECT throws_ok($$SELECT * FROM wallet$$, '42501', null, 'the table itself is nobody''s');
RESET ROLE;
SELECT acting_as(:'cara');
SELECT is(jsonb_array_length(my_items()), 0, 'Cara holds nothing');
SELECT throws_ok(format($$SELECT wallet_history(%L)$$, :'bens'), '42501',
                 'you do not hold that wallet', 'and cannot read Ben''s wallet');

-- walletd -------------------------------------------------------------------
RESET ROLE;
SELECT min(id) AS first FROM wallet_order \gset
SET LOCAL ROLE walletd;
SELECT is((walletd_next() ->> 'kind'), 'issue', 'walletd takes the next order');
SELECT ok(walletd_next() ->> 'id' <> :'first',
          'and a second walletd does not take the same one');
SELECT lives_ok(format($$SELECT walletd_said(%s, 'done', '')$$, :'first'),
                'and says it is done');
SELECT lives_ok(format($$SELECT walletd_seen(%L, 42, false)$$, :'bens'),
                'and writes down what a wallet holds');
SELECT throws_ok($$SELECT count(*) FROM auth.user$$, '42501', null,
                 'and reads nothing else');
RESET ROLE;
SELECT acting_as(:'ben');
SELECT throws_ok($$SELECT walletd_next()$$, '42501', null,
                 'a player cannot act as walletd');

SELECT * FROM finish();
ROLLBACK;
