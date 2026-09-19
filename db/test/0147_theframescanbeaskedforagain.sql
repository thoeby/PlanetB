-- A tile's frames can be asked for again without throwing the tile away.
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('redo147@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;

SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.86, 46.28, 7.92, 46.33);
SELECT compile_ground();

CREATE TEMP TABLE j AS
SELECT id FROM job WHERE state = 'open' AND z = 14 ORDER BY id LIMIT 1;

-- Walk the ground and the frames to verified the way a tab would: an atom
-- may only be claimed from ready, and verified from claimed
-- (db/0005_state.sql atom_state_guard).
CREATE TEMP TABLE w AS SELECT my_worker('{}'::jsonb) AS id;
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'init_ply', 4096, 'assemble-v11'),
       (repeat('b', 64), 'frames', 4096, 'frame-v10');
UPDATE atom SET state = 'claimed', worker_id = (SELECT id FROM w), claimed_at = now()
WHERE job_id = (SELECT id FROM j) AND op = 'assemble' AND state = 'ready';
UPDATE atom SET state = 'verified', output_sha256 = repeat('a', 64),
    worker_id = null, claimed_at = null
WHERE job_id = (SELECT id FROM j) AND op = 'assemble';
SELECT advance_atoms((SELECT id FROM j));
UPDATE atom SET state = 'claimed', worker_id = (SELECT id FROM w), claimed_at = now()
WHERE job_id = (SELECT id FROM j) AND op = 'frame' AND state = 'ready';
UPDATE atom SET state = 'verified', output_sha256 = repeat('b', 64),
    worker_id = null, claimed_at = null
WHERE job_id = (SELECT id FROM j) AND op = 'frame';
SELECT advance_atoms((SELECT id FROM j));
SELECT is((SELECT count(*) FROM atom WHERE job_id = (SELECT id FROM j)
           AND op = 'train' AND state = 'ready'), 1::bigint,
    'the training is the next thing anybody can take');
SELECT is((SELECT p ->> 'phase' FROM (SELECT pool_row((SELECT id FROM j)) AS p) AS q),
    'train', 'and the pool says the tile is waiting to be trained');

CREATE TEMP TABLE n AS SELECT redo_renders((SELECT id FROM j)) AS frames;
SELECT ok((SELECT frames FROM n) > 0, 'the frames are asked for again');
SELECT is((SELECT count(*) FROM atom WHERE job_id = (SELECT id FROM j)
           AND op = 'frame' AND state = 'ready'), (SELECT frames FROM n)::bigint,
    'every one of them, back in the pool');
SELECT is((SELECT state FROM atom WHERE job_id = (SELECT id FROM j) AND op = 'train'),
    'waiting', 'and the training waits for them');
SELECT is((SELECT e.detail FROM tile_event e WHERE e.job_id = (SELECT id FROM j)
           ORDER BY e.id DESC LIMIT 1),
    (SELECT frames FROM n) || ' frame(s) asked for again, and the training with them',
    'and the tile remembers being asked');

SELECT * FROM finish();
ROLLBACK;
