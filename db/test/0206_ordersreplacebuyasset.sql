-- Buying is an order (db/0206): confirm is idempotent by ref, refund reverses,
-- and a provider the world does not run leaves an order pending.
BEGIN;
SELECT plan(19);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-00000204c001', 'order-maker@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000204a001', 'order-buyer@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000204e001', 'order-op@example.com', 'x', 'admin');
INSERT INTO account (owner_id) VALUES
('00000000-0000-0000-0000-00000204c001'),
('00000000-0000-0000-0000-00000204a001'),
('00000000-0000-0000-0000-00000204e001');
DO $$
BEGIN
    PERFORM transfer(treasury_account(), a.id, 100, 'seed:order:' || a.owner_id)
    FROM account a WHERE a.owner_id = '00000000-0000-0000-0000-00000204a001';
END
$$;
-- The world's ground, set by the operator, with a tenth for the operator.
DELETE FROM ground;
INSERT INTO ground (geoserver_url, coverage, extent, set_by, rules)
VALUES ('http://gs.invalid', 'dem', st_makeenvelope(7, 46, 8, 47, 4326),
        '00000000-0000-0000-0000-00000204e001', '{"store_cut": 0.1}');

CREATE TEMP TABLE art AS
SELECT register_artifact(repeat('4', 64), 'glb', 1024, 'canon-v1') AS g;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000204c001","role":"player"}';
CREATE TEMP TABLE sans AS
SELECT register_asset(repeat('4', 64), 1::smallint,
    '{"name": "Brunnen", "license": "paid", "price": 10}'::jsonb) AS san;

CREATE TEMP TABLE bal AS
SELECT '00000000-0000-0000-0000-00000204a001'::uuid AS buyer,
       '00000000-0000-0000-0000-00000204c001'::uuid AS maker,
       '00000000-0000-0000-0000-00000204e001'::uuid AS op;
CREATE FUNCTION pg_temp.money(p uuid) RETURNS numeric LANGUAGE sql AS
$$SELECT account_balance((SELECT id FROM account WHERE owner_id = p))$$;

-- ------------------------------------------------------------- internal

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000204a001","role":"player"}';
CREATE TEMP TABLE o1 AS SELECT order_create((SELECT san FROM sans), 1, NULL) AS o;
SELECT is((SELECT o ->> 'state' FROM o1), 'paid',
          'the world''s own money pays and confirms in one transaction');
SELECT is((SELECT o ->> 'pay_url' FROM o1), NULL, 'with nowhere to go and pay');
SELECT is(pg_temp.money((SELECT buyer FROM bal)), 90::numeric, 'the buyer paid ten');
SELECT is(pg_temp.money((SELECT maker FROM bal)), 9::numeric, 'the maker was paid nine');
SELECT is(pg_temp.money((SELECT op FROM bal)), 1::numeric,
          'and the operator their tenth, the rule on the root area');
SELECT is((SELECT ref FROM asset_right WHERE san = (SELECT san FROM sans)),
          'buy:' || (SELECT san FROM sans) || ':00000000-0000-0000-0000-00000204a001',
          'the right carries the order''s ref, buy_asset''s own');

CREATE TEMP TABLE o1b AS SELECT order_confirm((SELECT (o ->> 'id')::uuid FROM o1), 'again') AS o;
SELECT is((SELECT count(*)::int FROM ledger WHERE ref LIKE (SELECT o ->> 'ref' FROM o1) || '%'), 2,
          'Invariant 5: confirming it again pays nobody twice');
SELECT is((SELECT issued FROM asset WHERE san = (SELECT san FROM sans)), 1,
          'and issues nothing twice');
SELECT is((SELECT order_create((SELECT san FROM sans), 1, NULL) ->> 'id'),
          (SELECT o ->> 'id' FROM o1), 'buying it again is the order already made');

-- ---------------------------------------------------------------- refund

SELECT throws_like(format($$SELECT order_refund(%L)$$, (SELECT o ->> 'id' FROM o1)),
    '%only its maker or an admin%', 'a buyer does not refund themselves');
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000204c001","role":"player"}';
CREATE TEMP TABLE r1 AS SELECT order_refund((SELECT (o ->> 'id')::uuid FROM o1)) AS o;
SELECT is((SELECT o ->> 'state' FROM r1), 'refunded', 'the maker refunds it');
SELECT is(pg_temp.money((SELECT buyer FROM bal)), 100::numeric,
          'the buyer has all ten back');
SELECT is(pg_temp.money((SELECT maker FROM bal)) + pg_temp.money((SELECT op FROM bal)),
          0::numeric, 'from the maker and the operator both');
SELECT is((SELECT count(*)::int FROM asset_right WHERE san = (SELECT san FROM sans)), 0,
          'and the right went with it');
SELECT is((SELECT count(*)::int FROM ledger WHERE ref LIKE 'refund:%' || (SELECT san FROM sans) || '%'),
          2, 'as new ledger rows: nothing was edited');

-- ---------------------------------------------------------- a provider

SELECT set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000204e001","role":"admin"}', true);
SELECT set_app_setting('store_provider', 'paylater');
SELECT set_app_setting('store_pay_url', 'https://pay.example/checkout?order=');
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000204a001","role":"player"}';
CREATE TEMP TABLE o2 AS SELECT order_create((SELECT san FROM sans), 1, NULL) AS o;
SELECT is((SELECT o ->> 'state' || ' ' || (o ->> 'provider') FROM o2), 'pending paylater',
          'a provider the world does not run is taken as given and left pending');
SELECT is((SELECT o ->> 'pay_url' FROM o2),
          'https://pay.example/checkout?order=' || (SELECT o ->> 'id' FROM o2),
          'with the address to go and pay at');
SELECT throws_like(format($$SELECT order_confirm(%L, 'pi_1')$$, (SELECT o ->> 'id' FROM o2)),
    '%not yours to confirm%', 'the buyer cannot say they paid');
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000204e001","role":"admin"}';
SELECT is(order_confirm((SELECT (o ->> 'id')::uuid FROM o2), 'pi_1') ->> 'state', 'paid',
          'an admin with the proof confirms it');

SELECT * FROM finish();
ROLLBACK;
