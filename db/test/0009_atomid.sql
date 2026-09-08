-- Two tiles that see the same world and have no published children must still
-- get atoms of their own (db/0009_atomid.sql).
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-0000000a1001', 'atomid@example.com', 'x', 'admin');
INSERT INTO account (owner_id) VALUES ('00000000-0000-0000-0000-0000000a1001');
INSERT INTO area (id, geom, owner_id, detail) VALUES
('00000000-0000-0000-0000-0000000a1002',
 st_makeenvelope(20.0, 20.0, 20.2, 20.2, 4326),
 '00000000-0000-0000-0000-0000000a1001', 14);

-- One feature spanning two neighbouring z14 tiles: identical world snapshot,
-- no children, same zoom — the case that used to collapse into one atom.
INSERT INTO feature (area_id, kind, geom) VALUES
('00000000-0000-0000-0000-0000000a1002', 'forest',
 st_force3d(st_makeenvelope(20.01, 20.01, 20.19, 20.19, 4326)));

SET LOCAL role = 'admin';
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000a1001","role":"admin"}';

CREATE TEMP TABLE tt AS
SELECT z, x, y, row_number() OVER (ORDER BY x, y) AS n
FROM tile WHERE z = 14 AND x BETWEEN tile_x(20.0, 14) AND tile_x(20.2, 14)
ORDER BY x, y LIMIT 2;

SELECT is((SELECT count(*)::int FROM tt), 2, 'two neighbouring z14 tiles are dirty');

CREATE TEMP TABLE jj AS
SELECT n, ensure_job(z, x, y) AS job FROM tt;

SELECT isnt((SELECT job FROM jj WHERE n = 1), (SELECT job FROM jj WHERE n = 2),
    'each tile gets its own job');
SELECT is((SELECT count(*)::int FROM atom WHERE job_id = (SELECT job FROM jj WHERE n = 1)),
    2, 'the first job has a merge and a sog');
SELECT is((SELECT count(*)::int FROM atom WHERE job_id = (SELECT job FROM jj WHERE n = 2)),
    2, 'the second job has a merge and a sog of its own');
SELECT isnt(
    (SELECT atom_hash FROM atom WHERE op = 'merge'
     AND job_id = (SELECT job FROM jj WHERE n = 1)),
    (SELECT atom_hash FROM atom WHERE op = 'merge'
     AND job_id = (SELECT job FROM jj WHERE n = 2)),
    'the two merge atoms are different computations');
SELECT is(
    (SELECT (params ->> 'x')::int FROM atom WHERE op = 'merge'
     AND job_id = (SELECT job FROM jj WHERE n = 1)),
    (SELECT x FROM tt WHERE n = 1),
    'the merge atom names the tile it merges');

SELECT * FROM finish();
ROLLBACK;
