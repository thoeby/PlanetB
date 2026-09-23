-- A tenth of the budget is a lattice across the ground, and the atoms are the
-- versions that carry it (db/0186).
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land186@example.com', 'password12') AS owner_id;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000186'::uuid,
       st_geomfromtext('POLYGON((7.88 46.29,7.89 46.29,7.89 46.30,7.88 46.30,7.88 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000186', 'building',
        st_geomfromtext('POINTZ(7.885 46.295 650)', 4326));
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT recompile_land('00000000-0000-0000-0000-000000000186');
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;
CREATE TEMP TABLE t AS
SELECT * FROM atom WHERE job_id = (SELECT jid FROM j) AND op = 'train';

SELECT is((SELECT algo_version FROM t), 'train-v20',
    'a seed with a lattice in it is a trainer of its own');
SELECT is((SELECT params ->> 'seed_share' FROM t), '0.3',
    'three tenths of the budget is seeded (db/0184)');
SELECT is((SELECT params ->> 'seed_grid' FROM t), '0.1',
    'and a tenth of the budget, a third of the seed, is the lattice');
SELECT is((SELECT params -> 'refine_every' FROM t), NULL,
    'the refine interval is brush''s own (db/0184)');
SELECT is((SELECT min(algo_version) FROM atom
           WHERE job_id = (SELECT jid FROM j) AND op = 'dataset'), 'dataset-v6',
    'the dataset writes the same seed, over mottled ground');
SELECT is(algo_current('train'), 'train-v20',
    'and the pool hands out the trainer that carries it');

SELECT * FROM finish();
ROLLBACK;
