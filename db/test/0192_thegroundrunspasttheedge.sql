-- The ground runs past the tile's edge and alpha counts for more (db/0192).
BEGIN;
SELECT plan(3);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land192@example.com', 'password12') AS owner_id;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000192'::uuid,
       st_geomfromtext('POLYGON((7.88 46.29,7.89 46.29,7.89 46.30,7.88 46.30,7.88 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000192', 'building',
        st_geomfromtext('POINTZ(7.885 46.295 650)', 4326));
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT recompile_land('00000000-0000-0000-0000-000000000192');
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;

SELECT is((SELECT algo_version FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'dataset'), 'dataset-v6',
    'the dataset carries the skirt');
SELECT is((SELECT (params -> 'brush' ->> 'match-alpha-weight')::numeric FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'train'), 0.5,
    'the frames'' alpha counts at half the colour');
SELECT is(algo_current('dataset'), 'dataset-v6', 'and the pool hands that out');

SELECT * FROM finish();
ROLLBACK;
