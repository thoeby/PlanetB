-- An atom whose job compiles a version the tile has moved past is not offered:
-- it could finish and still publish nothing (db/0052_staleclaim.sql).
BEGIN;
SELECT plan(4);

SET client_min_messages = warning;

INSERT INTO auth.user (id, email, pw_hash, role) VALUES
('00000000-0000-0000-0000-0000000d1001', 'staleclaim@example.com', 'x', 'player');
INSERT INTO account (owner_id) VALUES ('00000000-0000-0000-0000-0000000d1001');
INSERT INTO area (id, geom, owner_id, detail) VALUES
('00000000-0000-0000-0000-0000000d1002',
 st_makeenvelope(50.0, 50.0, 50.2, 50.2, 4326),
 '00000000-0000-0000-0000-0000000d1001', 14);
INSERT INTO feature (area_id, kind, geom) VALUES
('00000000-0000-0000-0000-0000000d1002', 'forest',
 st_force3d(st_makeenvelope(50.01, 50.01, 50.02, 50.02, 4326)));

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000d1001","role":"player"}';

CREATE TEMP TABLE pick AS SELECT t.z, t.x, t.y FROM tile t WHERE t.z = 14 LIMIT 1;
CREATE TEMP TABLE j AS
SELECT p.z, p.x, p.y, ensure_job(p.z, p.x, p.y) AS id FROM pick p;
GRANT SELECT ON pick, j TO player;

SET LOCAL role = 'player';
SELECT isnt((SELECT id FROM claim_atom('{}'::jsonb)), NULL,
            'the job is claimable while it compiles the version the tile wants');

-- Give the claim back, then move the tile on: this is what publishing a child
-- does to its parent, and what an edit does to a tile being compiled.
RESET ROLE;
UPDATE atom SET state = 'ready', worker_id = NULL, claimed_at = NULL
WHERE job_id = (SELECT id FROM j) AND state = 'claimed';
UPDATE tile SET expected_version = expected_version + 1, dirty = true
WHERE z = (SELECT z FROM j) AND x = (SELECT x FROM j) AND y = (SELECT y FROM j);

SET LOCAL role = 'player';
SELECT is((SELECT id FROM claim_atom('{}'::jsonb)), NULL,
          'once the tile has moved on, none of that job''s atoms is offered');

-- Nothing was cancelled or destroyed: the job and its atoms are as they were.
RESET ROLE;
SELECT is((SELECT state FROM job WHERE id = (SELECT id FROM j)), 'open',
          'the superseded job is left alone until ensure_job is asked again');
SELECT isnt((SELECT count(*)::int FROM atom WHERE job_id = (SELECT id FROM j)
             AND state = 'ready'), 0,
            'and its atoms are still ready, for a tile that comes back');

SELECT * FROM finish();
ROLLBACK;
