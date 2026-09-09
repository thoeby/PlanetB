-- WP4.4 acceptance: a right is bought once, charged once and issued once; the
-- last edition goes to exactly one buyer; a right passes on with the money
-- (db/0023_money.sql).
--
-- On the concurrency criterion, honestly: a pgTAP file is one session, so
-- nothing here runs two buyers at once. What it asserts instead is the
-- statement-level property the exclusion rests on — once the last edition is
-- sold, the predicate `buy_asset` takes its row lock with
-- (`issued < editions`) matches nothing, which is precisely what the second
-- session re-reads when it unblocks — plus the sold-out path the loser then
-- takes. That is evidence, not proof, of the race; two real sessions were run
-- by hand and behaved this way (one right, one ledger row, the loser refused).
-- Genuinely parallel sessions live in db/test/0006_concurrency.sh, and putting
-- buyers in there is for whoever next touches that file.
BEGIN;
SELECT plan(39);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-00000044c001', 'money-c@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000044a001', 'money-a@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000044b001', 'money-b@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000044d001', 'money-d@example.com', 'x', 'player');
INSERT INTO account (owner_id) VALUES
('00000000-0000-0000-0000-00000044c001'),
('00000000-0000-0000-0000-00000044a001'),
('00000000-0000-0000-0000-00000044b001'),
('00000000-0000-0000-0000-00000044d001');

DO $$
BEGIN
    PERFORM transfer(treasury_account(), a.id, 100, 'seed:money:' || a.owner_id)
    FROM account a
    WHERE a.owner_id IN ('00000000-0000-0000-0000-00000044a001',
                         '00000000-0000-0000-0000-00000044b001');
END
$$;

CREATE TEMP TABLE art AS
SELECT register_artifact(repeat('1', 64), 'glb', 1024, 'canon-v1') AS free_glb,
       register_artifact(repeat('2', 64), 'glb', 1024, 'canon-v1') AS paid_glb,
       register_artifact(repeat('3', 64), 'glb', 1024, 'canon-v1') AS ltd_glb;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000044c001","role":"player"}';
CREATE TEMP TABLE sans AS
SELECT register_asset(repeat('1', 64), 1::smallint,
           '{"name": "Free bench", "license": "cc0", "price": 3}'::jsonb) AS free_san,
       register_asset(repeat('2', 64), 1::smallint,
           '{"name": "Paid bench", "license": "paid", "price": 5}'::jsonb) AS paid_san,
       register_asset(repeat('3', 64), 1::smallint,
           '{"name": "Rare bench", "license": "limited", "price": 2,
             "editions": 1}'::jsonb) AS ltd_san;

SELECT has_function('public', 'buy_asset', ARRAY['text'], 'buy_asset()');
SELECT has_function('public', 'transfer_asset_right',
    ARRAY['text', 'uuid', 'numeric'], 'transfer_asset_right()');

SET LOCAL request.jwt.claims = '{}';
SELECT throws_ok(format($$SELECT buy_asset(%L)$$, (SELECT free_san FROM sans)),
    'PT401', null, 'nobody buys anonymously');

-- ------------------------------------------------------------------ cc0/free

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000044a001","role":"player"}';
SELECT throws_ok($$SELECT buy_asset('SAAAAAAAAAAAA')$$, 'PT404', null,
    'an asset nobody registered cannot be bought');

CREATE TEMP TABLE got_free AS SELECT * FROM buy_asset((SELECT free_san FROM sans));
SELECT is((SELECT ref FROM got_free),
    'buy:' || (SELECT free_san FROM sans) || ':00000000-0000-0000-0000-00000044a001',
    'the ref is buy:{san}:{user} (ARCHITECTURE §4)');
SELECT is((SELECT holder_id FROM got_free),
    '00000000-0000-0000-0000-00000044a001'::uuid, 'and the buyer holds it');
SELECT is(account_balance((SELECT id FROM account
    WHERE owner_id = '00000000-0000-0000-0000-00000044a001')), 100::numeric,
    'a cc0 right is free however the row is priced');
SELECT is((SELECT count(*)::int FROM ledger
    WHERE ref LIKE 'buy:' || (SELECT free_san FROM sans) || '%'), 0,
    'and writes no ledger row at all');
SELECT is((SELECT issued FROM asset WHERE san = (SELECT free_san FROM sans)), 1,
    'issued counts every right handed out, priced or not');

CREATE TEMP TABLE again_free AS SELECT * FROM buy_asset((SELECT free_san FROM sans));
SELECT is((SELECT ref FROM again_free), (SELECT ref FROM got_free),
    'buying twice returns the right already held');
SELECT is((SELECT issued FROM asset WHERE san = (SELECT free_san FROM sans)), 1,
    'and consumes nothing the second time');

-- ---------------------------------------------------------------------- paid

CREATE TEMP TABLE got_paid AS SELECT * FROM buy_asset((SELECT paid_san FROM sans));
SELECT is((SELECT holder_id FROM got_paid),
    '00000000-0000-0000-0000-00000044a001'::uuid, 'a paid right is held by its buyer');
SELECT is(account_balance((SELECT id FROM account
    WHERE owner_id = '00000000-0000-0000-0000-00000044a001')), 95::numeric,
    'the buyer paid the asking price');
SELECT is(account_balance((SELECT id FROM account
    WHERE owner_id = '00000000-0000-0000-0000-00000044c001')), 5::numeric,
    'and the creator was paid it');
SELECT ok((SELECT count(*) = 1 FROM ledger
    WHERE ref = 'buy:' || (SELECT paid_san FROM sans)
        || ':00000000-0000-0000-0000-00000044a001'),
    'Invariant 5: exactly one ledger row, under the ref that makes it idempotent');
SELECT is((SELECT editions FROM asset WHERE san = (SELECT paid_san FROM sans)), null,
    'a paid licence has no edition limit');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000044d001","role":"player"}';
SELECT throws_ok(format($$SELECT buy_asset(%L)$$, (SELECT paid_san FROM sans)),
    'P0001', null, 'an empty wallet buys nothing');
SELECT is((SELECT count(*)::int FROM asset_right
    WHERE san = (SELECT paid_san FROM sans)), 1,
    'and the failed buy left no right behind');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000044c001","role":"player"}';
CREATE TEMP TABLE own AS SELECT * FROM buy_asset((SELECT paid_san FROM sans));
SELECT ok((SELECT holder_id FROM own) = '00000000-0000-0000-0000-00000044c001'::uuid,
    'a creator may take a right in their own asset');
SELECT is(account_balance((SELECT id FROM account
    WHERE owner_id = '00000000-0000-0000-0000-00000044c001')), 5::numeric,
    'without paying themselves (the ledger forbids debit = credit)');

-- ------------------------------------------------------------------- limited

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000044a001","role":"player"}';
CREATE TEMP TABLE got_ltd AS SELECT * FROM buy_asset((SELECT ltd_san FROM sans));
SELECT is(account_balance((SELECT id FROM account
    WHERE owner_id = '00000000-0000-0000-0000-00000044a001')), 93::numeric,
    'a limited edition charges like a paid one');
SELECT is((SELECT issued FROM asset WHERE san = (SELECT ltd_san FROM sans)),
    (SELECT editions FROM asset WHERE san = (SELECT ltd_san FROM sans)),
    'and the last edition is now issued');

-- The lock itself, run by hand: this is the statement a second session blocks
-- on and re-evaluates against the committed row.
CREATE TEMP TABLE race AS
WITH u AS (
    UPDATE asset SET issued = issued + 1
    WHERE asset.san = (SELECT ltd_san FROM sans)
      AND (asset.editions IS NULL OR asset.issued < asset.editions)
    RETURNING san
)
SELECT san FROM u;
SELECT is((SELECT count(*)::int FROM race), 0,
    'the edition lock matches no row once the last edition is gone');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000044b001","role":"player"}';
SELECT throws_ok(format($$SELECT buy_asset(%L)$$, (SELECT ltd_san FROM sans)),
    'PT409', null, 'so the second buyer of the last edition is refused');
SELECT is((SELECT count(*)::int FROM asset_right
    WHERE san = (SELECT ltd_san FROM sans)), 1,
    'exactly one buyer holds the last edition');
SELECT is(account_balance((SELECT id FROM account
    WHERE owner_id = '00000000-0000-0000-0000-00000044b001')), 100::numeric,
    'and the loser was not charged');

-- ------------------------------------------------------- transfer as a gift

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000044a001","role":"player"}';
CREATE TEMP TABLE gift AS SELECT * FROM transfer_asset_right(
    (SELECT free_san FROM sans), '00000000-0000-0000-0000-00000044b001', 0);
SELECT is((SELECT holder_id FROM gift),
    '00000000-0000-0000-0000-00000044b001'::uuid,
    'the holder can pass a right on');
SELECT is((SELECT ref FROM gift), 'xfer:' || (SELECT ref FROM got_free)
    || ':00000000-0000-0000-0000-00000044b001',
    'the new ref chains onto the one it consumed, so it is unique too');
SELECT is((SELECT count(*)::int FROM asset_right
    WHERE san = (SELECT free_san FROM sans)), 1,
    'a transfer moves a right, it does not copy it');
SELECT is(account_balance((SELECT id FROM account
    WHERE owner_id = '00000000-0000-0000-0000-00000044a001')), 93::numeric,
    'a gift moves no money');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000044b001","role":"player"}';
SELECT throws_ok(format($$SELECT transfer_asset_right(%L,
    '00000000-0000-0000-0000-00000044a001', 5)$$, (SELECT free_san FROM sans)),
    'PT403', null, 'a holder cannot charge a wallet that is not theirs');
SELECT throws_ok(format($$SELECT transfer_asset_right(%L,
    '00000000-0000-0000-0000-00000044b001', 0)$$, (SELECT free_san FROM sans)),
    'PT400', null, 'nor transfer a right to themselves');

-- ------------------------------------------------------- transfer as a sale

CREATE TEMP TABLE sale AS SELECT * FROM transfer_asset_right(
    (SELECT paid_san FROM sans), '00000000-0000-0000-0000-00000044a001', 3);
SELECT is((SELECT holder_id FROM sale),
    '00000000-0000-0000-0000-00000044b001'::uuid,
    'the buyer of a held right takes it over');
SELECT is((SELECT ref FROM sale), 'xfer:' || (SELECT ref FROM got_paid)
    || ':00000000-0000-0000-0000-00000044b001', 'under a chained ref again');
SELECT is(account_balance((SELECT id FROM account
    WHERE owner_id = '00000000-0000-0000-0000-00000044b001')), 97::numeric,
    'the buyer paid what they offered');
SELECT is(account_balance((SELECT id FROM account
    WHERE owner_id = '00000000-0000-0000-0000-00000044a001')), 96::numeric,
    'and the seller was paid, in the same transaction');
SELECT is((SELECT issued FROM asset WHERE san = (SELECT paid_san FROM sans)), 2,
    'a resale issues nothing new');

-- --------------------------------------------------------- transfer refusals

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000044a001","role":"player"}';
CREATE TEMP TABLE rebought AS SELECT * FROM buy_asset((SELECT free_san FROM sans));
SELECT throws_ok(format($$SELECT transfer_asset_right(%L,
    '00000000-0000-0000-0000-00000044b001', 0)$$, (SELECT free_san FROM sans)),
    'PT409', null, 'a right cannot land on a holder who already has one');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000044d001","role":"player"}';
SELECT throws_ok(format($$SELECT transfer_asset_right(%L,
    '00000000-0000-0000-0000-00000044c001', 0)$$, (SELECT free_san FROM sans)),
    'PT404', null, 'and a stranger to both sides transfers nothing');

SELECT * FROM finish();
ROLLBACK;
