-- What a baseline tile is made of (db/0074_brightersplats.sql): how many splats
-- it may hold, and which sampler makes them. Both are pinned into the atom when
-- the job is built (Invariant 2), so this asks the DAG rather than the numbers.
BEGIN;
SELECT plan(5);

SELECT is(tile_budget(14), 800000::bigint,
          'a z14 tile holds what it held: the fix was the splats, not the count');
SELECT is(tile_budget(16), 600000::bigint, 'a trained z16 tile is unchanged');
SELECT is(tile_budget(18), 2000000::bigint, 'and so is a z18 one');

CREATE TEMP TABLE who AS SELECT register('splat74@example.com', 'password12') AS uid;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'player')::text, true) FROM who;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000d1'::uuid,
       st_makeenvelope(7.50, 46.50, 7.51, 46.51, 4326), uid, 14
FROM who;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000d1', 'footprint',
        st_geomfromtext('POINTZ(7.505 46.505 500)', 4326));

CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.505, 14), tile_y(46.505, 14), 0) AS id;
SELECT is((SELECT algo_version FROM atom
           WHERE job_id = (SELECT id FROM j) AND op = 'sample'),
          'sample-v2',
          'the sampler that carries the sun is the one the job asks for');
SELECT is((SELECT (params ->> 'budget')::bigint FROM atom
           WHERE job_id = (SELECT id FROM j) AND op = 'sample'),
          800000::bigint, 'and it is told how many to make');

SELECT * FROM finish();
ROLLBACK;
