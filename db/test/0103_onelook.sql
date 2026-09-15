-- The atoms a job is built with after db/0103_onelook.sql: assemble-v3,
-- frame-v5, sample-v4, and the iterations the baked frames need.
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land103@example.com', 'password12') AS owner_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000103'::uuid,
       st_geomfromtext('POLYGON((7.8 46.29,7.81 46.29,7.81 46.30,7.8 46.30,7.8 46.29))',
                       4326),
       ids.owner_id, 18
FROM ids;

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job(18, tile_x(7.805, 18), tile_y(46.295, 18)) AS j18,
       ensure_job(16, tile_x(7.805, 16), tile_y(46.295, 16)) AS j16,
       ensure_job(14, tile_x(7.805, 14), tile_y(46.295, 14)) AS j14;

SELECT is((SELECT algo_version FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'assemble'), 'assemble-v3',
    'assemble-v3 bakes the light');
SELECT is((SELECT min(algo_version) FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'frame'), 'frame-v5',
    'frame-v5 draws it as it is');
SELECT is((SELECT (params ->> 'iters')::int FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'train'), 2500,
    'z18: 2500 iterations');
SELECT is((SELECT (params ->> 'iters')::int FROM atom
           WHERE job_id = (SELECT j16 FROM jobs) AND op = 'train'), 2000,
    'z16: 2000 iterations');
SELECT is((SELECT algo_version FROM atom
           WHERE job_id = (SELECT j14 FROM jobs) AND op = 'sample'), 'sample-v4',
    'sample-v4 keeps the baked colour');
SELECT is((SELECT algo_version FROM atom
           WHERE job_id = (SELECT j14 FROM jobs) AND op = 'assemble'), 'assemble-v3',
    'a z14 job assembles with v3 too');

SELECT * FROM finish();
ROLLBACK;
