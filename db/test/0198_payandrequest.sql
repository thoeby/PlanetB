-- A wallet pays, and asks to be paid (db/0198_payandrequest.sql).
BEGIN;
SELECT plan(14);

DELETE FROM auth.user;
SELECT register('anna198@example.com', 'password12') AS anna,
       register('ben198@example.com', 'password12') AS ben,
       register('cara198@example.com', 'password12') AS cara \gset
UPDATE auth.user SET name = initcap(split_part(email, '198', 1));
INSERT INTO player_verification (player_id, state, method, how)
VALUES (:'ben', 'verified', 'manual', 'test');
SELECT id AS annas FROM item WHERE held_by = :'anna' \gset
SELECT id AS bens FROM item WHERE held_by = :'ben' \gset
UPDATE wallet SET balance = 100;

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

-- Paying ----------------------------------------------------------------------
SELECT acting_as(:'anna');
SELECT is(wallet_pay(:'annas', 'ben', 5, 'for the bread') ->> 'to', 'Ben',
          'Anna pays Ben by name');
RESET ROLE;
SELECT is((SELECT row(kind, other_id::text, amount, message, state)::text FROM wallet_order
           WHERE kind = 'pay'), format('(pay,%s,5.00,"for the bread",queued)', :'bens'),
          'and it is an order for walletd, with the message');
SELECT acting_as(:'anna');
SELECT throws_ok(format($$SELECT wallet_pay(%L, 'Ben', 100, '')$$, :'annas'), '23514',
                 'this wallet holds 95.00, not enough for 100.00',
                 'a payment the wallet plainly cannot cover says so');
SELECT throws_ok(format($$SELECT wallet_pay(%L, 'Ben', 0.001, '')$$, :'annas'), '23514',
                 null, 'cash comes in hundredths');
SELECT throws_ok(format($$SELECT wallet_pay(%L, 'Nobody', 1, '')$$, :'annas'), '23503',
                 'nobody called Nobody holds a wallet', 'nor to nobody');
SELECT throws_ok(format($$SELECT wallet_pay(%L, 'Anna', 1, '')$$, :'bens'), '42501',
                 'you do not hold that wallet', 'nobody spends a wallet they do not hold');
RESET ROLE;
SELECT acting_as(:'cara');
SELECT throws_ok(format($$SELECT wallet_pay(%L, 'Anna', 1, '')$$, :'bens'), '42501',
                 null, 'not even to its holder');

-- Requesting ----------------------------------------------------------------
RESET ROLE;
SELECT acting_as(:'ben');
SELECT ok((wallet_request(:'bens', 'Anna', 3, 'the rest') ->> 'order') IS NOT null,
          'Ben asks Anna for 3');
RESET ROLE;
SELECT id AS ask FROM wallet_order WHERE kind = 'request' \gset
SELECT acting_as(:'ben');
SELECT throws_ok(format($$SELECT answer_request(%s, true)$$, :'ask'), '42501',
                 'you do not hold that wallet', 'Ben cannot answer for Anna');
RESET ROLE;
UPDATE wallet_order SET state = 'asked' WHERE id = :'ask';
SELECT is((SELECT words FROM notification WHERE user_id = :'anna' AND kind = 'cash'),
          'Ben asks you for 3.00: the rest', 'Anna is told what Ben asks, and why');
SELECT acting_as(:'anna');
SELECT is(wallet_history(:'annas') -> 0 ->> 'asks_me', 'true', 'and sees it in her wallet');
SELECT is(answer_request(:'ask', true) ->> 'state', 'confirmed', 'Anna confirms');
SELECT throws_ok(format($$SELECT answer_request(%s, true)$$, :'ask'), '23514',
                 'that request is confirmed already', 'once');
RESET ROLE;
UPDATE wallet_order SET state = 'done' WHERE id = :'ask';
SELECT is((SELECT words FROM notification WHERE user_id = :'ben' AND kind = 'cash'),
          'Anna paid what you asked: 3.00', 'Ben is told it was paid');

SELECT * FROM finish();
ROLLBACK;
