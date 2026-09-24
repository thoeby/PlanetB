-- MN.0, the switch (db/0197_creditsbecomecash.sql): credits arrive as cash.
BEGIN;
SELECT plan(8);

DELETE FROM auth.user;
SELECT register('anna197@example.com', 'password12') AS anna,
       register('ben197@example.com', 'password12') AS ben \gset
SELECT id AS bens_account FROM account WHERE owner_id = :'ben' \gset
DELETE FROM wallet_order;
SELECT transfer(treasury_account(), :'bens_account', 40, 'seed:197');
INSERT INTO tile (z, x, y, dirty, expected_version) VALUES (16, 34300, 22900, true, 1);
INSERT INTO job (id, z, x, y, target_version, state, bounty)
VALUES (919701, 16, 34300, 22900, 1, 'open', 15);
SELECT transfer(:'bens_account', escrow_account(), 15, 'bounty:919701:' || :'ben' || ':1');

SELECT is(credits_become_cash(), 1, 'one player had credits');
SELECT is((SELECT bounty FROM job WHERE id = 919701), 0.00,
          'the price Ben had held on a job came back first');
SELECT is((SELECT count(*)::int FROM item WHERE held_by = :'ben'), 1,
          'Ben, not verified, holds a wallet with his credits in it');
SELECT is((SELECT amount FROM wallet_order WHERE ref = 'switch:' || :'bens_account'), 40.00,
          'all forty of them, as cash');
SELECT is(account_balance(:'bens_account'), 0::numeric, 'and the ledger holds none');
SELECT is((SELECT count(*)::int FROM ledger WHERE ref = 'switch:' || :'bens_account'), 1,
          'its last line says where they went');
SELECT is(credits_become_cash(), 0, 'switching again finds nothing to switch');
SELECT throws_ok($$SET LOCAL ROLE player; SELECT set_bounty(919701, 1)$$, '42501', null,
                 'and the ledger''s ways of paying are nobody''s any more');

SELECT * FROM finish();
ROLLBACK;
