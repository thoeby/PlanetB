-- The trainer's own params (db/0075_trainknowsitscameras.sql). It holds poses
-- back and scores against them, and which ones is the camera set's answer, so
-- the atom has to carry the set's name. Without it every train atom failed on
-- its first line.
BEGIN;
SELECT plan(4);

CREATE TEMP TABLE who AS SELECT register('train75@example.com', 'password12') AS uid;
SELECT set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'player')::text, true) FROM who;
INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-0000000000e1'::uuid,
       st_makeenvelope(7.50, 46.50, 7.505, 46.505, 4326), uid, 16
FROM who;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-0000000000e1', 'building',
        st_geomfromtext('POINTZ(7.502 46.502 500)', 4326));

CREATE TEMP TABLE j AS
SELECT ensure_job(16, tile_x(7.502, 16), tile_y(46.502, 16), 0) AS id;

SELECT is((SELECT params ->> 'camera_set' FROM atom
           WHERE job_id = (SELECT id FROM j) AND op = 'train'),
          'z16-v3', 'a z16 trainer knows which set it is learning from (db/0182)');
SELECT is((SELECT count(DISTINCT params ->> 'camera_set') FROM atom
           WHERE job_id = (SELECT id FROM j) AND op IN ('train', 'dataset')),
          1::bigint, 'and it is the one the dataset beside it was rendered with');
SELECT ok((SELECT (params ->> 'needs_webgpu')::boolean FROM atom
           WHERE job_id = (SELECT id FROM j) AND op = 'train'),
          'training still says it wants a GPU');
-- One tile, one folder (db/0183): the dataset atom draws the whole set.
SELECT is((SELECT (params ->> 'views')::int FROM atom
           WHERE job_id = (SELECT id FROM j) AND op = 'dataset'),
          81, 'and the dataset draws every view of an 81-view set');

SELECT * FROM finish();
ROLLBACK;
