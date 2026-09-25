-- A product has a current and a legacy version, and a right says which it
-- follows (db/0207).
BEGIN;
SELECT plan(12);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-00000205c001', 'chan-maker@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000205a001', 'chan-subs@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000205b001', 'chan-pin@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000205d001', 'chan-once@example.com', 'x', 'player');
INSERT INTO account (owner_id) SELECT id FROM auth.user WHERE email LIKE 'chan-%';
DO $$
BEGIN
    PERFORM transfer(treasury_account(), a.id, 100, 'seed:chan:' || a.owner_id)
    FROM account a JOIN auth.user u ON u.id = a.owner_id WHERE u.email LIKE 'chan-%';
END
$$;

CREATE TEMP TABLE art AS
SELECT register_artifact(repeat('5', 64), 'glb', 1024, 'canon-v1') AS v1,
       register_artifact(repeat('6', 64), 'glb', 1024, 'canon-v1') AS v2,
       register_artifact(repeat('7', 64), 'glb', 1024, 'canon-v1') AS v3,
       register_artifact(repeat('8', 64), 'glb', 1024, 'canon-v1') AS s1,
       register_artifact(repeat('9', 64), 'glb', 1024, 'canon-v1') AS p1;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000205c001","role":"player"}';
CREATE TEMP TABLE sans AS
SELECT register_asset(repeat('5', 64), 1::smallint,
           '{"name": "Brunnen", "license": "paid", "price": 2}'::jsonb) AS once_san,
       register_asset(repeat('8', 64), 1::smallint,
           '{"name": "Laterne", "license": "paid", "price": 1, "policy": "subscription",
             "term": "30 days"}'::jsonb) AS subs_san,
       register_asset(repeat('9', 64), 1::smallint,
           '{"name": "Denkmal", "license": "paid", "price": 1, "policy": "pinned"}'::jsonb)
           AS pin_san;

SELECT is((SELECT pointer ->> 'current' FROM asset WHERE san = (SELECT once_san FROM sans)),
          repeat('5', 64), 'a product starts pointing at the file it was registered with');
SELECT is(policy_words(a), 'Subscription: every update for as long as it is paid '
          || '(30 days at a time); after that, the last legacy version.',
          'and says which model applies before anybody buys')
FROM asset a WHERE a.san = (SELECT subs_san FROM sans);

-- ---------------------------------------------------------- subscription

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000205a001","role":"player"}';
CREATE TEMP TABLE subbed AS SELECT order_create((SELECT subs_san FROM sans), 1, NULL) AS o;
SELECT ok((SELECT until FROM asset_right WHERE san = (SELECT subs_san FROM sans))
          > now() + interval '29 days', 'a subscription runs for its term');
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000205c001","role":"player"}';
SELECT set_pointer((SELECT subs_san FROM sans), 'legacy', repeat('8', 64));
SELECT set_pointer((SELECT subs_san FROM sans), 'current', repeat('6', 64));
SELECT is(right_sha((SELECT subs_san FROM sans), '00000000-0000-0000-0000-00000205a001'),
          repeat('6', 64), 'while it is paid, it follows every move of current');
UPDATE asset_right SET until = now() - interval '1 day'
WHERE san = (SELECT subs_san FROM sans);
SELECT is(right_sha((SELECT subs_san FROM sans), '00000000-0000-0000-0000-00000205a001'),
          repeat('8', 64), 'an expired subscription resolves to the legacy hash');
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000205a001","role":"player"}';
CREATE TEMP TABLE renewed AS SELECT order_create((SELECT subs_san FROM sans), 1, NULL) AS o;
SELECT is(right_sha((SELECT subs_san FROM sans), '00000000-0000-0000-0000-00000205a001'),
          repeat('6', 64), 'and a new paid order brings it back to current');

-- ----------------------------------------------------------------- pinned

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000205b001","role":"player"}';
CREATE TEMP TABLE pinned AS SELECT order_create((SELECT pin_san FROM sans), 1, NULL) AS o;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000205c001","role":"player"}';
SELECT set_pointer((SELECT pin_san FROM sans), 'current', repeat('7', 64), true);
SELECT is(right_sha((SELECT pin_san FROM sans), '00000000-0000-0000-0000-00000205b001'),
          repeat('9', 64), 'a pinned right ignores a pointer move, even a fix');

-- ------------------------------------------------------------- bought once

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000205d001","role":"player"}';
CREATE TEMP TABLE once AS SELECT order_create((SELECT once_san FROM sans), 1, NULL) AS o;
UPDATE asset_right SET acquired_at = now() - interval '1 hour'
WHERE san = (SELECT once_san FROM sans);
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000205c001","role":"player"}';
SELECT set_pointer((SELECT once_san FROM sans), 'current', repeat('6', 64), false);
SELECT is(right_sha((SELECT once_san FROM sans), '00000000-0000-0000-0000-00000205d001'),
          repeat('5', 64), 'a buy-once right keeps its version through a new one');
SELECT set_pointer((SELECT once_san FROM sans), 'current', repeat('7', 64), true);
SELECT is(right_sha((SELECT once_san FROM sans), '00000000-0000-0000-0000-00000205d001'),
          repeat('7', 64), 'and receives a move its maker flagged a fix');
SELECT is((SELECT count(*)::int FROM asset_version WHERE san = (SELECT once_san FROM sans)), 3,
          'every move is recorded, and nothing else is');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000205d001","role":"player"}';
SELECT throws_like(format($$SELECT set_pointer(%L, 'current', %L)$$,
    (SELECT once_san FROM sans), repeat('5', 64)), '%only its maker%',
    'nobody but the maker moves it');
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000205c001","role":"player"}';
SELECT throws_like(format($$SELECT set_pointer(%L, 'current', %L)$$,
    (SELECT once_san FROM sans), repeat('e', 64)), '%no glb artifact%',
    'and only to a file the world holds');

SELECT * FROM finish();
ROLLBACK;
