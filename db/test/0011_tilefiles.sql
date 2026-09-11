-- The heightmap and colliders of a tile are writable by whoever holds its sog
-- atom, and by nobody else (db/0011_tilefiles.sql).
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-0000000b1001', 'tilefiles@example.com', 'x', 'player'),
('00000000-0000-0000-0000-0000000b1002', 'stranger@example.com', 'x', 'player');
INSERT INTO account (owner_id) VALUES
('00000000-0000-0000-0000-0000000b1001'), ('00000000-0000-0000-0000-0000000b1002');
INSERT INTO area (id, geom, owner_id, detail) VALUES
('00000000-0000-0000-0000-0000000b1003',
 st_makeenvelope(30.0, 30.0, 30.2, 30.2, 4326),
 '00000000-0000-0000-0000-0000000b1001', 10);
INSERT INTO feature (area_id, kind, geom) VALUES
('00000000-0000-0000-0000-0000000b1003', 'forest',
 st_force3d(st_makeenvelope(30.01, 30.01, 30.02, 30.02, 4326)));

-- ensure_job authorises against the caller, so the owner has to be the caller.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000b1001","role":"player"}';

CREATE TEMP TABLE pick AS SELECT t.z, t.x, t.y FROM tile t WHERE t.z = 10 LIMIT 1;

-- One published child, because a merge that has none is not claimable at all
-- (db/0035_mergeready.sql) and this test is about who may write tile files.
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('9', 64), 'sog', 10, 'sog-v1');
INSERT INTO tile (z, x, y, dirty, expected_version, sog_sha256)
SELECT 12, p.x * 4, p.y * 4, false, 1, repeat('9', 64) FROM pick p
ON CONFLICT (z, x, y) DO UPDATE SET sog_sha256 = excluded.sog_sha256;

CREATE TEMP TABLE holder AS
SELECT p.z, p.x, p.y, ensure_job(p.z, p.x, p.y) AS job FROM pick p;
-- Created as the superuser, read after SET ROLE.
GRANT SELECT ON holder TO player;

-- The owner claims the tile's merge, finishes it, and claims the sog.
SET LOCAL role = 'player';

CREATE TEMP TABLE claimed AS SELECT * FROM claim_atom('{}'::jsonb);
SELECT is((SELECT op FROM claimed), 'merge', 'the merge is claimed first');
CREATE TEMP TABLE reg AS
SELECT register_artifact(repeat('1', 64), 'ply', 10, 'merge-v1') AS sha;
CREATE TEMP TABLE sub AS
SELECT submit_atom((SELECT id FROM claimed), repeat('1', 64),
                   '{"splat_count": 1, "bytes": 10, "finite": true,
                     "bbox": [-5, 0, -5, 5, 2, 5]}'::jsonb) AS state;
SELECT is((SELECT state FROM sub), 'verified', 'and verified');
CREATE TEMP TABLE sogatom AS SELECT * FROM claim_atom('{}'::jsonb);
SELECT is((SELECT op FROM sogatom), 'sog', 'then the sog');

SELECT lives_ok(
    format('SELECT can_write(''/tiles/%s/%s/%s/%s.r16'', %L)',
           (SELECT z FROM holder), (SELECT x FROM holder), (SELECT y FROM holder),
           repeat('2', 64), repeat('2', 64)),
    'the sog holder may write the tile heightmap');
SELECT lives_ok(
    format('SELECT can_write(''/tiles/%s/%s/%s/%s.json'', %L)',
           (SELECT z FROM holder), (SELECT x FROM holder), (SELECT y FROM holder),
           repeat('3', 64), repeat('3', 64)),
    'and its colliders');

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000b1002","role":"player"}';
SELECT throws_ok(
    format('SELECT can_write(''/tiles/%s/%s/%s/%s.r16'', %L)',
           (SELECT z FROM holder), (SELECT x FROM holder), (SELECT y FROM holder),
           repeat('4', 64), repeat('4', 64)),
    'PT403', NULL, 'a stranger may not');

SELECT * FROM finish();
ROLLBACK;
