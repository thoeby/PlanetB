-- What a baseline tile is made of (db/0074_brightersplats.sql): how many splats
-- it may hold, and which sampler makes them. Both are pinned into the atom when
-- the job is built (Invariant 2), so this asks the DAG rather than the numbers.
BEGIN;
SELECT plan(5);

-- Cut in db/0111 and db/0115, and put back in db/0116: the numbers the
-- trainer ran with.
SELECT is(tile_budget(14), 800000::bigint, 'what a z14 tile holds (db/0116)');
SELECT is(tile_budget(16), 600000::bigint, 'what a trained z16 tile holds');
SELECT is(tile_budget(18), 2000000::bigint, 'and a z18 one');

CREATE TEMP TABLE who AS SELECT register('splat74@example.com', 'password12') AS uid;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'player')::text, true) FROM who;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000d1'::uuid,
       st_makeenvelope(7.50, 46.50, 7.51, 46.51, 4326), uid, 14
FROM who;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000d1', 'building',
        st_geomfromtext('POINTZ(7.505 46.505 500)', 4326));

CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.505, 14), tile_y(46.505, 14), 0) AS id;
-- The sampler is gone: a z14 tile is trained like any other, which is
-- db/0080_onesky.sql's business. What 0074 settled is how many splats it is
-- worth, and that number is still pinned into the atom that spends it.
SELECT ok((SELECT algo_version FROM atom
           WHERE job_id = (SELECT id FROM j) AND op = 'train') LIKE 'train-v%',
          'a z14 tile is trained');
SELECT is((SELECT (params ->> 'budget')::bigint FROM atom
           WHERE job_id = (SELECT id FROM j) AND op = 'train'),
          800000::bigint, 'and it is told how many to make');

SELECT * FROM finish();
ROLLBACK;
