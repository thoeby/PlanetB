-- A trained tile is built with the numbers that ran (db/0116),
-- and says how much of the budget to seed and how wide to write what comes back.
BEGIN;
SELECT plan(6);

SET client_min_messages = warning;

SELECT is(tile_budget(14), 600000::bigint, 'a z14 tile holds what every tile does (db/0136)');
SELECT is(tile_budget(16), 600000::bigint, 'and a z16 tile too');
SELECT is(tile_budget(12), 600000::bigint, 'and a merged tile the same again (db/0136)');

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

SELECT is((SELECT algo_version FROM t), 'train-v9', 'the trainer is train-v9');
SELECT is((SELECT (params ->> 'iters')::int FROM t), 1200, 'over 1200 steps (db/0122)');
SELECT is((SELECT jsonb_build_array(params -> 'seed_share', params -> 'scale',
                                    params -> 'refine_every') FROM t),
    '[0.0375, 1.3, 20]'::jsonb,
    'seeded small, widened a little, and refined often enough to fill (db/0138)');

SELECT * FROM finish();
ROLLBACK;
