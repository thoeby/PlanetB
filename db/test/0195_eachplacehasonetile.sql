-- A tile keeps the splats over its own ground (db/0195): train-v22.
BEGIN;
SELECT plan(3);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land195@example.com', 'password12') AS owner_id;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000195'::uuid,
       st_geomfromtext('POLYGON((7.88 46.29,7.89 46.29,7.89 46.30,7.88 46.30,7.88 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000195', 'building',
        st_geomfromtext('POINTZ(7.885 46.295 650)', 4326));
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT recompile_land('00000000-0000-0000-0000-000000000195');
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;

SELECT is((SELECT algo_version FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'train'), 'train-v22',
    'the tile trains with train-v22');
SELECT is((SELECT algo_version FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'dataset'), 'dataset-v8',
    'and its ground meets the neighbour''s at the edge');
SELECT is(algo_current('train'), 'train-v22', 'and the pool hands that out');

SELECT * FROM finish();
ROLLBACK;
