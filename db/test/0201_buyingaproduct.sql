-- A licence is handed over when the payment is in (db/0201_buyingaproduct.sql).
BEGIN;
SELECT plan(13);

DELETE FROM auth.user;
SELECT register('anna201@example.com', 'password12') AS anna,
       register('ben201@example.com', 'password12') AS ben,
       register('cara201@example.com', 'password12') AS cara \gset
UPDATE auth.user SET name = initcap(split_part(email, '201', 1));
INSERT INTO player_verification (player_id, state, method, how)
VALUES (:'ben', 'verified', 'manual', 'test'), (:'cara', 'verified', 'manual', 'test');
SELECT id AS bens FROM item WHERE held_by = :'ben' \gset
SELECT id AS caras FROM item WHERE held_by = :'cara' \gset
UPDATE wallet SET balance = 100;
DELETE FROM wallet_order;
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('c', 64), 'glb', 10, 'canon-v1') ON CONFLICT DO NOTHING;
INSERT INTO asset (san, sha256, canon_version, name, category, license, price, editions,
                   bbox, tris, tex_bytes, creator_id) VALUES
('SBENCHBENCHBE', repeat('c', 64), 1, 'Valais bench', 'furniture', 'limited', 12, 1,
 '[0,0,0,1,1,1]', 12, 0, :'cara'),
('SFREEFREEFREE', repeat('c', 64), 1, 'Stone', 'flora', 'cc0', 0, null,
 '[0,0,0,1,1,1]', 12, 0, :'cara');

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

SELECT acting_as(:'ben');
SELECT is(buy('SFREEFREEFREE') ->> 'state', 'held', 'a free licence is Ben''s at once');
SELECT is(buy('SBENCHBENCHBE') ->> 'to', 'Cara', 'buying the bench asks Ben to pay Cara');
SELECT is(buy('SBENCHBENCHBE') ->> 'state', 'queued', 'asking twice is the one ask');
RESET ROLE;
SELECT id AS o FROM wallet_order WHERE ref = 'buy:SBENCHBENCHBE:' || :'ben' \gset
SELECT is((SELECT row(wallet_id::text, other_id::text, amount)::text FROM wallet_order
           WHERE id = :'o'), format('(%s,%s,12.00)', :'caras', :'bens'),
          'Cara''s wallet asks Ben''s for the price');
SELECT is((SELECT issued FROM asset WHERE san = 'SBENCHBENCHBE'), 1, 'the edition is taken');
SELECT acting_as(:'anna');
SELECT throws_ok($$SELECT buy('SBENCHBENCHBE')$$, 'PT409', 'SBENCHBENCHBE is sold out',
                 'so the last one cannot be bought twice');
RESET ROLE;

SELECT walletd_said(:'o', 'asked', '');
SELECT is((SELECT state FROM wallet_order WHERE id = :'o'), 'confirmed',
          'Ben said yes when he pressed Buy: it is paid as soon as it is asked');
SELECT ok(NOT EXISTS (SELECT 1 FROM asset_right WHERE san = 'SBENCHBENCHBE'),
          'no licence before the cash is in');
SELECT walletd_said(:'o', 'done', '');
SELECT is((SELECT holder_id::text FROM asset_right WHERE san = 'SBENCHBENCHBE'), :'ben',
          'paid, Ben holds the licence');
SELECT is((SELECT words FROM notification WHERE user_id = :'cara' AND kind = 'cash'),
          'Ben bought Valais bench for 12.00', 'and Cara is told');
SELECT acting_as(:'ben');
SELECT is(buy('SBENCHBENCHBE') ->> 'state', 'held', 'buying it again is holding it');

-- A payment that never arrives gives the edition back.
RESET ROLE;
DELETE FROM asset_right WHERE san = 'SBENCHBENCHBE';
UPDATE wallet_order SET state = 'asked' WHERE id = :'o';
UPDATE wallet_order SET state = 'failed' WHERE id = :'o';
SELECT is((SELECT issued FROM asset WHERE san = 'SBENCHBENCHBE'), 0,
          'a buy that failed gives the edition back');
SELECT acting_as(:'ben');
SELECT is(buy('SBENCHBENCHBE') ->> 'state', 'queued', 'and it can be bought again');

SELECT * FROM finish();
ROLLBACK;
