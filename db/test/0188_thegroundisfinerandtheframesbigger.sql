-- The ground is cut from z16, the frames are 1280 px, brush refines every
-- 100 steps (db/0188).
BEGIN;
SELECT plan(5);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land188@example.com', 'password12') AS owner_id;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000188'::uuid,
       st_geomfromtext('POLYGON((7.88 46.29,7.89 46.29,7.89 46.30,7.88 46.30,7.88 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000188', 'building',
        st_geomfromtext('POINTZ(7.885 46.295 650)', 4326));
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT recompile_land('00000000-0000-0000-0000-000000000188');
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;

SELECT is((SELECT min(algo_version) FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'dataset'), 'dataset-v9',
    'the dataset is the version with the finer ground');
SELECT is((SELECT (params ->> 'dem_deeper')::int FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'dataset'), 2,
    'a z14 tile''s ground is cut two zooms deeper, from z16');
SELECT is(world_default('frame_px'), '1280', 'frames are 1280 px unless the world says');
SELECT is((SELECT (params ->> 'refine_every')::int FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'train'), 100,
    'brush refines every 100 steps');
SELECT is(algo_current('dataset'), 'dataset-v9', 'and the pool hands that out');

SELECT * FROM finish();
ROLLBACK;
