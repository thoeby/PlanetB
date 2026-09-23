-- The frames a tile was trained on are found wherever they live, and can be
-- asked for again a land or a world at a time. Resetting by job_id alone
-- missed them: new_atom hands an atom to whichever job asks for it next, so a
-- training job's frames are often on another job's row.
BEGIN;
SELECT plan(5);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('redo149@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;

SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.86, 46.28, 7.92, 46.33);
SELECT compile_ground();

CREATE TEMP TABLE j AS
SELECT id, z, x, y FROM job WHERE state = 'open' AND z = 14 ORDER BY id LIMIT 1;
CREATE TEMP TABLE w AS SELECT my_worker('{}'::jsonb) AS id;
INSERT INTO artifact (sha256, kind, bytes, algo_version)
VALUES (repeat('a', 64), 'dataset', 4096, 'dataset-v5');

-- The dataset is the ground and the frames in one (db/0183).
UPDATE atom SET state = 'claimed', worker_id = (SELECT id FROM w), claimed_at = now()
WHERE job_id = (SELECT id FROM j) AND op = 'dataset' AND state = 'ready';
UPDATE atom SET state = 'verified', output_sha256 = repeat('a', 64), worker_id = null
WHERE job_id = (SELECT id FROM j) AND op = 'dataset';
SELECT advance_atoms((SELECT id FROM j));

-- The frames wander off to another job's row, the way an adoption leaves them.
CREATE TEMP TABLE moved AS
SELECT id FROM atom WHERE job_id = (SELECT id FROM j) AND op = 'dataset';
UPDATE atom SET job_id = (SELECT max(id) FROM job WHERE state = 'open')
WHERE id IN (SELECT id FROM moved);

SELECT ok((SELECT count(*) FROM moved) > 0, 'the tile had frames');
SELECT is(redo_renders((SELECT id FROM j)), (SELECT count(*) FROM moved)::int,
    'and they are found on whatever row they have got to');
SELECT is((SELECT count(*) FROM atom WHERE id IN (SELECT id FROM moved)
           AND state = 'ready'), (SELECT count(*) FROM moved),
    'every one of them back in the pool');
SELECT is((SELECT state FROM atom WHERE job_id = (SELECT id FROM j) AND op = 'train'),
    'waiting', 'and the training waits for them');

-- A land at a time.
CREATE TEMP TABLE a AS SELECT create_area(
    '{"type":"Polygon","coordinates":[[[7.870,46.290],[7.910,46.290],
                                       [7.910,46.320],[7.870,46.320],[7.870,46.290]]]}'::jsonb,
    14, 'redo149') AS id;
SELECT ok(redo_land_renders((SELECT id FROM a)) >= 0,
    'a whole land can be asked at once');

SELECT * FROM finish();
ROLLBACK;
