-- Every open tab says it is a peer, and what it holds (db/0213).
BEGIN;
SELECT plan(7);

SET client_min_messages = warning;
INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-00000211b001', 'peer-b@example.com', 'x', 'player'),
('00000000-0000-0000-0000-00000211c001', 'peer-c@example.com', 'x', 'player');

SELECT throws_like($$SELECT register_peer('12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '{}', '{bafkone}')$$, '%sign in first%', 'an anonymous tab lists nothing');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000211b001","role":"player"}';
SELECT is(register_peer('12D3KooWBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    '{/p2p-circuit/b}', '{bafkone,bafktwo}', 7.86, 46.29), 2, 'B''s tab says what it holds');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000211c001","role":"player"}';
SELECT throws_like($$SELECT register_peer('12D3KooWBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    '{}', '{}')$$, '%somebody else%', 'C cannot speak for B''s tab');
SELECT register_peer('12D3KooWCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    '{/p2p-circuit/c}', '{bafkone}');
SELECT is(jsonb_array_length(peers_for('bafkone')), 2, 'both tabs hold the first file');
SELECT is(peers_for('bafkone', '12D3KooWCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC')
    -> 0 ->> 'player', player_name('00000000-0000-0000-0000-00000211b001'),
    'the asker leaves itself out, and is told whose tab the other is');

UPDATE peer SET seen_at = now() - interval '5 minutes'
WHERE peer_id LIKE '12D3KooWB%';
SELECT is(jsonb_array_length(peers_for('bafktwo')), 0, 'a tab not heard from is not asked');

SELECT unregister_peer('12D3KooWCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC');
SELECT ok(NOT EXISTS (SELECT 1 FROM peer WHERE peer_id LIKE '12D3KooWC%'),
    'closing the tab takes it away');

SELECT * FROM finish();
ROLLBACK;
