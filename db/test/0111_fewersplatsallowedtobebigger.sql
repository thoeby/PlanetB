-- A trained tile is built with the numbers that ran (db/0116),
-- and says how much of the budget to seed and how wide to write what comes back.
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

SELECT is(tile_budget(14), 800000::bigint, 'a z14 tile holds what it ran with (db/0116)');
SELECT is(tile_budget(16), 600000::bigint, 'and a z16 tile too');
SELECT is(tile_budget(12), 900000::bigint, 'a merged tile is what it was');

CREATE TEMP TABLE ids AS
SELECT register('land111@example.com', 'password12') AS owner_id;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000112'::uuid,
       st_geomfromtext('POLYGON((7.88 46.29,7.89 46.29,7.89 46.30,7.88 46.30,7.88 46.29))',
                       4326),
       ids.owner_id, 14
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000112', 'footprint',
        st_geomfromtext('POINTZ(7.885 46.295 650)', 4326));
SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
SELECT recompile_land('00000000-0000-0000-0000-000000000112');
CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.885, 14), tile_y(46.295, 14)) AS jid;
CREATE TEMP TABLE t AS
SELECT * FROM atom WHERE job_id = (SELECT jid FROM j) AND op = 'train';

SELECT is((SELECT algo_version FROM t), 'train-v7', 'the trainer is train-v7');
SELECT is((SELECT (params ->> 'iters')::int FROM t), 1200, 'over 1200 steps (db/0122)');
SELECT is((SELECT jsonb_build_array(params -> 'seed_share', params -> 'scale') FROM t),
    '[0.125, 3]'::jsonb,
    'seeded at an eighth (db/0118), every splat written three times as wide (db/0121)');

SELECT * FROM finish();
ROLLBACK;
