-- Dropping a job takes its pieces with it, so compiling the tile again
-- computes them rather than adopting the ones just thrown away.
BEGIN;
SELECT plan(5);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS SELECT register('drop150@example.com', 'password12') AS owner_id;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'admin')::text, true) FROM ids;

SELECT set_ground('http://gs.example/geoserver', 'dev:dem', 7.86, 46.28, 7.92, 46.33);
SELECT compile_ground();

CREATE TEMP TABLE j AS
SELECT id, z, x, y FROM job WHERE state = 'open' AND z = 14 ORDER BY id LIMIT 1;
CREATE TEMP TABLE before AS
SELECT count(*) AS n FROM atom WHERE job_id = (SELECT id FROM j);

SELECT ok((SELECT n FROM before) > 0, 'the job has pieces');
SELECT ok(drop_job((SELECT id FROM j)), 'and it can be dropped');
SELECT is((SELECT count(*) FROM job WHERE id = (SELECT id FROM j)), 0::bigint,
    'the job is gone, not cancelled');
SELECT is((SELECT count(*) FROM atom WHERE job_id = (SELECT id FROM j)), 0::bigint,
    'and its pieces with it, so nothing adopts them back');
SELECT is((SELECT e.kind FROM tile_event e WHERE e.z = (SELECT z FROM j)
           AND e.x = (SELECT x FROM j) AND e.y = (SELECT y FROM j)
           ORDER BY e.id DESC LIMIT 1), 'gave_up',
    'and the tile remembers being dropped');

SELECT * FROM finish();
ROLLBACK;
