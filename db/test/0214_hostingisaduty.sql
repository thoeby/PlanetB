-- A tab keeps a land's files for a term, and is paid for what it served
-- (db/0214).
BEGIN;
SELECT plan(11);

SET client_min_messages = warning;
INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-00000212b001', 'host-owner@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000212c001', 'host-keeper@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000212a001', 'host-reader@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000212d001', 'host-other@example.com', 'x', 'player');
INSERT INTO account (owner_id) SELECT id FROM auth.user WHERE email LIKE 'host-%';
DO $$
BEGIN
    PERFORM transfer(treasury_account(), a.id, 10, 'seed:host')
    FROM account a WHERE a.owner_id = '00000000-0000-0000-0000-00000212b001';
END
$$;

INSERT INTO artifact (sha256, kind, bytes, algo_version, cid) VALUES
(repeat('a', 64), 'glb', 300, 'canon-v2', 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaa'),
(repeat('b', 64), 'glb', 100, 'canon-v2', 'bafkreibbbbbbbbbbbbbbbbbbbbbbbbb');
INSERT INTO asset (san, sha256, canon_version, name, category, bbox, tris, tex_bytes,
                   license, creator_id, type)
VALUES ('SHOSTHOSTHOST', repeat('a', 64), 2, 'Tor', 'prop', '{}', 1, 0, 'cc0',
        '00000000-0000-0000-0000-00000212b001', 'model'),
       ('SHOSTHOSTHOSB', repeat('b', 64), 2, 'Bank', 'prop', '{}', 1, 0, 'cc0',
        '00000000-0000-0000-0000-00000212b001', 'model');
INSERT INTO area (id, geom, owner_id, detail) VALUES ('00000000-0000-0000-0000-0000000212a1',
    st_setsrid(st_makeenvelope(7.86, 46.285, 7.864, 46.287), 4326),
    '00000000-0000-0000-0000-00000212b001', 14);
INSERT INTO instance (area_id, san, lon, lat) VALUES
('00000000-0000-0000-0000-0000000212a1', 'SHOSTHOSTHOST', 7.862, 46.286),
('00000000-0000-0000-0000-0000000212a1', 'SHOSTHOSTHOSB', 7.8621, 46.286);
INSERT INTO peer (peer_id, player_id) VALUES
('12D3KooWKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK', '00000000-0000-0000-0000-00000212c001');

SELECT is(jsonb_array_length(region_files('00000000-0000-0000-0000-0000000212a1')), 2,
    'the land names two files');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000212d001","role":"player"}';
SELECT throws_like($$SELECT offer_host('00000000-0000-0000-0000-0000000212a1', '1 hour', 1)$$,
    '%your own land%', 'nobody has somebody else''s land hosted');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000212b001","role":"player"}';
CREATE TEMP TABLE d AS
SELECT offer_host('00000000-0000-0000-0000-0000000212a1', '1 hour', 4) AS id;
GRANT SELECT ON d TO player;
SELECT is(account_balance(my_account()), 6::numeric, 'the bounty is in escrow');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000212a001","role":"player"}';
SELECT throws_like($$SELECT claim_host((SELECT id FROM d),
    '12D3KooWKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK')$$, '%not one of your tabs%',
    'a tab is hosted from by its own player only');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000212c001","role":"player"}';
SELECT is(jsonb_array_length(claim_host((SELECT id FROM d),
    '12D3KooWKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK') -> 'files'), 2,
    'the keeper''s tab takes it, and is told the files');
SELECT ok(NOT host_served('12D3KooWKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK',
    'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaa'), 'a keeper serving itself is no receipt');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000212a001","role":"player"}';
SELECT ok(host_served('12D3KooWKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK',
    'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaa'), 'a reader who got the gate from it says so');
SELECT ok(NOT host_served('12D3KooWKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK',
    'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaa'), 'once per player and file');
SELECT ok(NOT host_served('12D3KooWKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK',
    'bafkreicccccccccccccccccccccccccc'), 'and only for files of the region');
SELECT throws_like($$SELECT settle_duty((SELECT id FROM d))$$, '%term runs until%',
    'not before the term is over');

UPDATE duty SET ends_at = now() - interval '1 second' WHERE id = (SELECT id FROM d);
SELECT settle_duty((SELECT id FROM d));
SELECT is(account_balance((SELECT id FROM account
    WHERE owner_id = '00000000-0000-0000-0000-00000212c001')), 3::numeric,
    'three quarters of the bytes served, three quarters of the bounty; the rest goes back');

SELECT * FROM finish();
ROLLBACK;
