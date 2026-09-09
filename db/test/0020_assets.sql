-- The catalog's write path: a SAN derived from the artifact, never chosen; a
-- second registration of the same bytes is a no-op; near-duplicates are found
-- by name and by shape (db/0020_assets.sql).
BEGIN;
SELECT plan(15);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-0000000c1001', 'asset-a@example.com', 'x', 'player'),
('00000000-0000-0000-0000-0000000c1002', 'asset-b@example.com', 'x', 'player');
INSERT INTO account (owner_id) VALUES
('00000000-0000-0000-0000-0000000c1001'), ('00000000-0000-0000-0000-0000000c1002');

-- The digest client/lib/canon.js produces for the WP4.1 fixtures, and the SAN
-- it derives from it. The two implementations have to agree or an upload would
-- be filed under a number the uploader never saw.
SELECT is(derive_san('7d12295f8acad2b5d6bdfb4177a51858bbe86f5e0d8d306f1691d8b6f89de951'),
          'SPUJCSX4KZLJL', 'the SAN of the fixture bench matches canon.js');
SELECT is(derive_san(repeat('0', 64)), 'S' || repeat('A', 12),
          'an all-zero digest is all A');
SELECT is(derive_san(repeat('f', 64)), 'S' || repeat('7', 12),
          'an all-one digest is all 7');
SELECT matches(derive_san(repeat('9', 64)), '^S[A-Z2-7]{12}$',
               'every SAN satisfies the column check');
SELECT throws_ok($$SELECT derive_san('not-a-digest')$$, 'PT400',
                 null, 'a malformed digest is refused');

-- ------------------------------------------------------------- register_asset

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000c1001","role":"player"}';

SELECT throws_ok(
    format($$SELECT register_asset(%L, 1::smallint, '{}'::jsonb)$$, repeat('a', 64)),
    'PT404', null, 'an asset needs an artifact that exists');

CREATE TEMP TABLE art AS
SELECT register_artifact(repeat('a', 64), 'glb', 2048, 'canon-v1') AS glb,
       register_artifact(repeat('b', 64), 'thumb', 512, 'thumb-v1') AS thumb;

CREATE TEMP TABLE reg AS
SELECT register_asset(repeat('a', 64), 1::smallint, jsonb_build_object(
    'name', 'Park bench', 'category', 'furniture', 'tris', 36,
    'tex_bytes', 16516, 'license', 'cc0',
    'bbox', '{"min":[-0.9,0,-0.25],"max":[0.9,0.5,0.25]}'::jsonb,
    'thumb_sha256', repeat('b', 64))) AS san;
GRANT SELECT ON reg TO player;

SELECT is((SELECT san FROM reg), derive_san(repeat('a', 64)),
          'the SAN comes from the artifact, not the caller');
SELECT is((SELECT creator_id FROM asset WHERE san = (SELECT san FROM reg)),
          '00000000-0000-0000-0000-0000000c1001'::uuid,
          'the creator is whoever registered it');
SELECT is((SELECT thumb_sha256 FROM asset WHERE san = (SELECT san FROM reg)),
          repeat('b', 64), 'the thumbnail is linked');

-- Invariant 1: the same bytes are the same asset, so a second registration —
-- by anyone — changes nothing.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000c1002","role":"player"}';
CREATE TEMP TABLE again AS
SELECT register_asset(repeat('a', 64), 1::smallint,
                      '{"name": "Stolen bench"}'::jsonb) AS san;
SELECT is((SELECT san FROM again), (SELECT san FROM reg),
          'registering the same bytes twice returns the same SAN');
SELECT is((SELECT count(*)::int FROM asset), 1, 'and creates no second asset');
SELECT is((SELECT name FROM asset WHERE san = (SELECT san FROM reg)), 'Park bench',
          'the second registration cannot rename it');

-- ------------------------------------------------------------ near-duplicates

SELECT is((SELECT count(*)::int FROM similar_assets('PARK BENCH', 999,
              '{"min":[0,0,0],"max":[9,9,9]}'::jsonb)), 1,
          'the same name is a near-duplicate whatever the shape');
SELECT is((SELECT count(*)::int FROM similar_assets('Something else', 37,
              '{"min":[-0.91,0,-0.25],"max":[0.9,0.51,0.25]}'::jsonb)), 1,
          'so is the same shape and triangle count under another name');
SELECT is((SELECT count(*)::int FROM similar_assets('Something else', 3600,
              '{"min":[-9,0,-2.5],"max":[9,5,2.5]}'::jsonb)), 0,
          'a bench ten times the size is not');

SELECT * FROM finish();
ROLLBACK;
