-- The train atom says how much of its seed goes on the ground (db/0174).
BEGIN;
SELECT plan(3);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land174@example.com', 'password12') AS owner_id;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000174'::uuid,
       st_geomfromtext('POLYGON((7.88 46.29,7.89 46.29,7.89 46.30,7.88 46.30,7.88 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000174', 'building',
        st_geomfromtext('POINTZ(7.885 46.295 650)', 4326));
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT recompile_land('00000000-0000-0000-0000-000000000174');
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;
CREATE TEMP TABLE t AS
SELECT * FROM atom WHERE job_id = (SELECT jid FROM j) AND op = 'train';

SELECT is((SELECT algo_version FROM t), 'train-v15',
    'the ground being seeded first is a trainer of its own');
SELECT is((SELECT params ->> 'ground_floor' FROM t), '0.66',
    'two thirds of the seed is the ground''s, whatever stands on it');
SELECT is((SELECT params ->> 'seed_share' FROM t), '0.1',
    'and the seed is still a tenth of the budget');

SELECT * FROM finish();
ROLLBACK;
