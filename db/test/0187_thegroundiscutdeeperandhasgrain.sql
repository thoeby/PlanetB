-- The dataset is the version that cuts the ground deeper (db/0187).
BEGIN;
SELECT plan(2);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land187@example.com', 'password12') AS owner_id;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000187'::uuid,
       st_geomfromtext('POLYGON((7.88 46.29,7.89 46.29,7.89 46.30,7.88 46.30,7.88 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000187', 'building',
        st_geomfromtext('POINTZ(7.885 46.295 650)', 4326));
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT recompile_land('00000000-0000-0000-0000-000000000187');
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;

SELECT is((SELECT min(algo_version) FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'dataset'), 'dataset-v4',
    'the ground is cut a zoom deeper and drawn with a grain');
SELECT is(algo_current('dataset'), 'dataset-v4', 'and the pool hands that out');

SELECT * FROM finish();
ROLLBACK;
