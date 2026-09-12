-- The same bytes can belong to two tiles: every tile with no buildings has the
-- same colliders, and each needs them at its own address (db/0051_sharedbytes.sql).
BEGIN;
SELECT plan(5);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-0000000c1001', 'sharedbytes@example.com', 'x', 'player'),
('00000000-0000-0000-0000-0000000c1002', 'stranger-shared@example.com', 'x', 'player');
INSERT INTO account (owner_id) VALUES
('00000000-0000-0000-0000-0000000c1001'), ('00000000-0000-0000-0000-0000000c1002');
INSERT INTO area (id, geom, owner_id, detail) VALUES
('00000000-0000-0000-0000-0000000c1003',
 st_makeenvelope(40.0, 40.0, 40.2, 40.2, 4326),
 '00000000-0000-0000-0000-0000000c1001', 10);
INSERT INTO feature (area_id, kind, geom) VALUES
('00000000-0000-0000-0000-0000000c1003', 'forest',
 st_force3d(st_makeenvelope(40.01, 40.01, 40.02, 40.02, 4326)));

-- ensure_job authorises against the caller, so the owner has to be the caller.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000c1001","role":"player"}';

CREATE TEMP TABLE pick AS SELECT t.z, t.x, t.y FROM tile t WHERE t.z = 10 LIMIT 1;

-- One published child, because a merge that has none is not claimable at all
-- (db/0035_mergeready.sql) and this test is about who may write tile files.
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('8', 64), 'sog', 10, 'sog-v1');
INSERT INTO tile (z, x, y, dirty, expected_version, sog_sha256)
SELECT 12, p.x * 4, p.y * 4, false, 1, repeat('8', 64) FROM pick p
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


-- Another tile published these exact colliders first, so the artifact is
-- already registered and the bytes are under that tile, not this one.
CREATE TEMP TABLE shared AS SELECT repeat('7', 64) AS sha;
RESET ROLE;
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('7', 64), 'colliders', 13, 'assemble-v1');
SET LOCAL role = 'player';

SELECT lives_ok(
    format('SELECT can_write(''/tiles/%s/%s/%s/%s.json'', %L)',
           (SELECT z FROM holder), (SELECT x FROM holder), (SELECT y FROM holder),
           (SELECT sha FROM shared), (SELECT sha FROM shared)),
    'a registered artifact may still be written at this tile''s own address');
SELECT throws_ok(
    format('SELECT can_write(''/jobs/%s/%s.json'', %L)',
           (SELECT id FROM sogatom), (SELECT sha FROM shared), (SELECT sha FROM shared)),
    'PT403', NULL,
    'but not a second time into a job directory, which is nobody''s address');

SELECT * FROM finish();
ROLLBACK;
