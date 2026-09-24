-- The frames of a trained tile are drawn by one dataset atom of one version,
-- and the renderer choice rides along in its params, so a tile is drawn the
-- same way whichever tab is handed it (Invariant 2).
--
-- It used to say frame-v3 and 32 paths a pixel, and then a frame atom per
-- chunk of the camera set; see db/test/0092 and db/0183.
BEGIN;
SELECT plan(4);

SET client_min_messages = warning;

CREATE TEMP TABLE ids AS
SELECT register('land97@example.com', 'password12') AS owner_id;

INSERT INTO area (id, geom, owner_id, detail)
SELECT '00000000-0000-0000-0000-000000000097'::uuid,
       st_geomfromtext('POLYGON((7.8 46.29,7.81 46.29,7.81 46.30,7.8 46.30,7.8 46.29))',
                       4326),
       ids.owner_id, 18
FROM ids;
INSERT INTO feature (area_id, kind, geom)
VALUES ('00000000-0000-0000-0000-000000000097', 'building',
        st_geomfromtext('POINTZ(7.805 46.295 650)', 4326));

SELECT set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'player')::text, true) FROM ids;
CREATE TEMP TABLE jobs AS
SELECT ensure_job(18, tile_x(7.805, 18), tile_y(46.295, 18)) AS j18;

SELECT is((SELECT count(*) FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'dataset'), 1::bigint,
    'a z18 job has one dataset atom for its camera set');
SELECT is((SELECT (params ->> 'views')::int FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'dataset'),
    camera_views(18), 'which draws every view of it');
SELECT is((SELECT min(algo_version) FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'dataset'), 'dataset-v7',
    'and that version is the one the client publishes');
SELECT ok((SELECT params @> frame_renderer() FROM atom
           WHERE job_id = (SELECT j18 FROM jobs) AND op = 'dataset'),
    'and it carries the renderer the operator chose');

SELECT * FROM finish();
ROLLBACK;
