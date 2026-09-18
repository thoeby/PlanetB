-- The train atom a z18 and a z16 job are built with: train-v7, the iteration
-- counts a full-budget seed needs, and z18 trained at the frames' own size.
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land95@example.com', 'password12') AS owner_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000095'::uuid,
       st_geomfromtext('POLYGON((7.8 46.29,7.81 46.29,7.81 46.30,7.8 46.30,7.8 46.29))',
                       4326),
       ids.owner_id, 18
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000095', 'building',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job(18, tile_x(7.805, 18), tile_y(46.295, 18)) AS j18,
       ensure_job(16, tile_x(7.805, 16), tile_y(46.295, 16)) AS j16;

SELECT is((SELECT algo_version FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'train'), 'train-v7',
    'a z18 job trains with train-v7');
SELECT is((SELECT (params ->> 'iters')::int FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'train'), 1200,
    'z18: 1200 iterations (db/0122)');
SELECT is((SELECT (params ->> 'size')::int FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'train'), 1024,
    'z18 trains at the frames'' own 1024 px (db/0116)');
SELECT is((SELECT algo_version FROM atom
           WHERE job_id = (SELECT j16 FROM jobs) AND op = 'train'), 'train-v7',
    'a z16 job trains with train-v7');
SELECT is((SELECT (params ->> 'iters')::int FROM atom
           WHERE job_id = (SELECT j16 FROM jobs) AND op = 'train'), 1200,
    'z16: 1200 iterations (db/0122)');
SELECT is((SELECT (params ->> 'size')::int FROM atom
           WHERE job_id = (SELECT j16 FROM jobs) AND op = 'train'), 1024,
    'z16 trains at the frames'' own 1024 px (db/0116)');

SELECT * FROM finish();
ROLLBACK;
