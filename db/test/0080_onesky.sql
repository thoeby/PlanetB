-- The world is lit by a sky, and the splats go where there is something to see
-- (db/0080_onesky.sql). What this can check is the DAG: that a job asks for the
-- versions the client publishes. What the light looks like is
-- client/test/light.test.js and the player's own eyes.
BEGIN;
SELECT plan(4);

CREATE TEMP TABLE who AS SELECT register('sky80@example.com', 'password12') AS uid;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'player')::text, true) FROM who;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000c1'::uuid,
       st_makeenvelope(7.40, 46.40, 7.41, 46.41, 4326), uid, 14
FROM who;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000c1', 'building',
        st_geomfromtext('POINTZ(7.405 46.405 500)', 4326));

CREATE TEMP TABLE j AS
SELECT ensure_job(14, tile_x(7.405, 14), tile_y(46.405, 14), 0) AS id;

SELECT is((SELECT algo_version FROM atom
           WHERE job_id = (SELECT id FROM j) AND op = 'assemble'),
          'assemble-v10', 'the geometry is assembled under the new sky');
SELECT is((SELECT algo_version FROM atom
           WHERE job_id = (SELECT id FROM j) AND op = 'train'),
          'train-v13', 'and trained by the trainer the client runs');
SELECT is((SELECT (params ->> 'budget')::bigint FROM atom
           WHERE job_id = (SELECT id FROM j) AND op = 'train'),
          600000::bigint, 'with the budget every tile has: what moved is where they go');

-- A z16 tile is trained, and the trainer still knows which cameras it was shown
-- (db/0075_trainknowsitscameras.sql): a later build_dag must not drop that.
SELECT set_area_detail('00000000-0000-0000-0000-0000000000c1', 16);
CREATE TEMP TABLE j16 AS
SELECT ensure_job(16, tile_x(7.405, 16), tile_y(46.405, 16), 0) AS id;
SELECT is((SELECT params ->> 'camera_set' FROM atom
           WHERE job_id = (SELECT id FROM j16) AND op = 'train'),
          'z16-v2', 'the trainer is still told which cameras it was shown');

SELECT * FROM finish();
ROLLBACK;
